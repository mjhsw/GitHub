
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const MAX_IMAGES = 6;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 30000;
const MAX_CHAT_LENGTH = 12000;
const MAX_QUESTIONS = 100;
const QUESTIONS_PER_BATCH = 5;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE,
    files: MAX_IMAGES
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return callback(new Error('이미지 파일만 업로드할 수 있습니다.'));
    }
    callback(null, true);
  }
});

const studyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
  }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: '채팅 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
  }
});

let groq = null;

function getGroq() {
  if (groq) return groq;

  if (!process.env.GROQ_API_KEY) {
    throw new Error('서버 환경변수 GROQ_API_KEY가 설정되지 않았습니다.');
  }

  groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  return groq;
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function extractJson(text) {
  if (!text) throw new Error('AI 응답이 비어 있습니다.');

  let value = String(text).trim();

  value = value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(value);
  } catch {}

  const firstBrace = value.indexOf('{');
  const lastBrace = value.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = value.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error('AI가 올바른 JSON 형식으로 답변하지 않았습니다.');
}

function normalizeQuestion(question, index) {
  if (!question || typeof question !== 'object') return null;

  const questionText = cleanText(
    question.question || question.text || question.title,
    3000
  );

  const rawOptions = Array.isArray(question.options)
    ? question.options
    : [];

  const options = rawOptions
    .map(option => cleanText(
      typeof option === 'string' ? option : option?.text,
      1000
    ))
    .filter(Boolean);

  if (!questionText || options.length < 2) return null;

  let answer = Number(question.answer);

  if (!Number.isInteger(answer)) {
    const answerText = cleanText(question.answer, 1000);
    answer = options.findIndex(option => option === answerText);
  }

  if (answer < 0 || answer >= options.length) return null;

  return {
    id: `question-${Date.now()}-${index}`,
    question: questionText,
    options,
    answer,
    explanation: cleanText(
      question.explanation || question.solution || question.reason,
      4000
    ) || '정답에 대한 설명이 제공되지 않았습니다.',
    difficulty: cleanText(question.difficulty || '보통', 30),
    concept: cleanText(question.concept || '', 200)
  };
}

function questionKey(question) {
  return question.question
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.,!?'"“”‘’()[\]{}:;]/g, '');
}

async function requestJson(client, messages, options = {}) {
  const response = await client.chat.completions.create({
    model: options.model || MODEL,
    messages,
    temperature: options.temperature ?? 0.4,
    max_completion_tokens: options.maxTokens || 6000,
    response_format: { type: 'json_object' }
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('AI로부터 답변을 받지 못했습니다.');
  }

  return extractJson(content);
}

async function extractTextFromImages(client, files) {
  if (!files?.length) return '';

  const extracted = [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const base64 = file.buffer.toString('base64');
    const dataUrl = `data:${file.mimetype};base64,${base64}`;

    const response = await client.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            '당신은 학습 자료를 정확하게 읽는 OCR 전문가입니다.',
            '이미지에 실제로 적힌 내용만 추출하세요.',
            '문제, 보기, 정답, 해설, 표, 수식, 숫자, 단위, 제목을 빠뜨리지 마세요.',
            '수학 기호와 분수, 지수, 루트, 부등호를 가능한 한 정확하게 표현하세요.',
            '읽을 수 없는 부분은 [판독 불가]라고 표시하세요.',
            '내용을 임의로 만들어 내거나 요약하지 마세요.',
            '페이지 순서와 문항 번호를 유지하세요.'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `학습 자료 이미지 ${index + 1}번입니다. 이미지의 글자를 순서대로 모두 추출해 주세요.`
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ],
      temperature: 0,
      max_completion_tokens: 4000
    });

    const text = response.choices?.[0]?.message?.content;

    if (text) {
      extracted.push(`\n[이미지 ${index + 1}]\n${text}`);
    }
  }

  return extracted.join('\n').slice(0, MAX_TEXT_LENGTH);
}

async function createSummary(client, material, title) {
  const data = await requestJson(client, [
    {
      role: 'system',
      content: [
        '당신은 모든 교과목을 가르치는 전문 학습 분석 AI입니다.',
        '반드시 제공된 학습 자료에 근거해서 분석하세요.',
        '자료에 없는 사실을 있는 것처럼 만들지 마세요.',
        '응답은 JSON 객체만 출력하세요.',
        'summary는 핵심 내용을 이해하기 쉽게 설명하세요.',
        'keyTerms는 중요 용어와 그 뜻을 배열로 작성하세요.',
        'examPoints는 시험에 나올 만한 핵심 포인트를 배열로 작성하세요.',
        'sourceTopics는 자료에서 확인되는 주요 개념을 배열로 작성하세요.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `
자료 제목: ${title || '학습 자료'}

아래 자료를 분석해 주세요.

${material}

다음 JSON 형식으로 답변하세요.
{
  "summary": "전체 핵심 요약",
  "keyTerms": [
    { "term": "용어", "meaning": "뜻과 설명" }
  ],
  "examPoints": [
    "시험 핵심 포인트"
  ],
  "sourceTopics": [
    "자료에서 실제로 확인되는 개념"
  ]
}
`
    }
  ], { maxTokens: 6000 });

  return {
    summary: cleanText(data.summary, 12000),
    keyTerms: Array.isArray(data.keyTerms) ? data.keyTerms : [],
    examPoints: Array.isArray(data.examPoints) ? data.examPoints : [],
    sourceTopics: Array.isArray(data.sourceTopics) ? data.sourceTopics : []
  };
}

async function createQuestionBatch(
  client,
  material,
  title,
  batchNumber,
  requestedCount,
  existingQuestions
) {
  const existing = existingQuestions.map((question, index) => (
    `${index + 1}. ${question.question}`
  )).join('\n');

  const data = await requestJson(client, [
    {
      role: 'system',
      content: [
        '당신은 업로드된 학습 자료를 바탕으로 시험 문제를 만드는 출제 전문가입니다.',
        '가장 중요한 규칙은 원본 자료와의 관련성입니다.',
        '자료에 없는 단원이나 개념을 임의로 추가하지 마세요.',
        '원본 문제를 그대로 복사하지 말고 같은 개념을 활용한 새로운 유사 문제를 만드세요.',
        '숫자, 조건, 보기, 상황을 바꾸어 응용 문제를 만드세요.',
        '문제마다 정답과 해설을 반드시 작성하세요.',
        '정답 번호는 0부터 시작합니다.',
        '보기는 객관식 5개를 기본으로 작성하세요.',
        '정답이 하나만 존재하도록 검토하세요.',
        '자료가 부족하면 억지로 다른 단원의 문제를 만들지 마세요.',
        '응답은 JSON 객체만 출력하세요.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `
[학습 자료 제목]
${title || '학습 자료'}

[원본 학습 자료]
${material}

[이번 생성 요청]
이번 요청에서 새로운 문제를 정확히 ${requestedCount}개 만들어 주세요.
이번은 ${batchNumber}번째 생성 묶음입니다.

[이미 생성된 문제 - 중복 금지]
${existing || '아직 생성된 문제가 없습니다.'}

[출제 규칙]
1. 원본 자료에 등장하는 개념과 학습 목표를 사용하세요.
2. 원본의 문제 유형을 분석하고 비슷한 유형으로 출제하세요.
3. 숫자나 조건을 바꾸어 계산·추론하는 문제를 만드세요.
4. 단순히 문장만 바꾼 복사 문제는 만들지 마세요.
5. 앞에서 생성한 문제와 질문 방식, 수치, 정답이 겹치지 않게 하세요.
6. 자료에 수학 공식이 있으면 같은 공식을 활용한 응용 문제를 만드세요.
7. 자료가 국어라면 작품, 문법, 표현법, 독해 등 실제 자료의 내용을 활용하세요.
8. 자료가 영어라면 지문과 문법, 어휘, 문장 구조 등 실제 자료의 내용을 활용하세요.
9. 자료가 과학·사회·역사 등 다른 과목이면 해당 자료의 핵심 개념을 활용하세요.
10. 자료에 없는 내용을 정답의 근거로 사용하지 마세요.
11. 각 문제의 정답과 해설을 확인한 뒤 제출하세요.
12. 문제 수는 반드시 ${requestedCount}개여야 합니다.

JSON 형식:
{
  "questions": [
    {
      "question": "문제 내용",
      "options": ["보기 1", "보기 2", "보기 3", "보기 4", "보기 5"],
      "answer": 0,
      "explanation": "정답인 이유와 풀이",
      "difficulty": "쉬움/보통/어려움",
      "concept": "활용한 원본 자료의 개념"
    }
  ]
}
`
    }
  ], { maxTokens: 6000, temperature: 0.5 });

  if (!Array.isArray(data.questions)) {
    throw new Error('AI가 문제 목록을 올바르게 반환하지 않았습니다.');
  }

  return data.questions
    .map((question, index) => normalizeQuestion(
      question,
      batchNumber * 100 + index
    ))
    .filter(Boolean);
}

async function createStudyResult(client, material, title, requestedCount) {
  const summary = await createSummary(client, material, title);

  const questions = [];
  const used = new Set();

  let batchNumber = 0;
  let consecutiveEmptyBatches = 0;
  const maxAttempts = Math.ceil(requestedCount / QUESTIONS_PER_BATCH) * 3 + 3;

  while (questions.length < requestedCount && batchNumber < maxAttempts) {
    batchNumber++;

    const remaining = requestedCount - questions.length;
    const batchSize = Math.min(QUESTIONS_PER_BATCH, remaining);

    const batch = await createQuestionBatch(
      client,
      material,
      title,
      batchNumber,
      batchSize,
      questions
    );

    let added = 0;

    for (const question of batch) {
      const key = questionKey(question);

      if (!key || used.has(key)) continue;

      used.add(key);
      questions.push(question);
      added++;

      if (questions.length >= requestedCount) break;
    }

    if (added === 0) {
      consecutiveEmptyBatches++;
    } else {
      consecutiveEmptyBatches = 0;
    }

    if (consecutiveEmptyBatches >= 3) {
      break;
    }
  }

  if (questions.length !== requestedCount) {
    const error = new Error(
      `요청한 ${requestedCount}문제 중 ${questions.length}문제만 생성되었습니다. 자료가 부족하거나 AI 응답이 불완전할 수 있습니다. 자료를 더 선명하게 올린 뒤 다시 시도해 주세요.`
    );
    error.status = 502;
    error.generatedCount = questions.length;
    error.requestedCount = requestedCount;
    throw error;
  }

  return {
    ...summary,
    questions,
    requestedQuestionCount: requestedCount,
    generatedQuestionCount: questions.length,
    questionCountComplete: true
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: '공부킬러',
    model: MODEL,
    visionModel: VISION_MODEL
  });
});

app.post(
  '/api/study',
  studyLimiter,
  upload.array('images', MAX_IMAGES),
  async (req, res) => {
    try {
      const client = getGroq();

      const title = cleanText(req.body.title, 200);
      const typedText = cleanText(req.body.text, MAX_TEXT_LENGTH);
      const requestedCount = clampNumber(
        req.body.questionCount,
        1,
        MAX_QUESTIONS,
        20
      );

      const files = req.files || [];

      if (!typedText && files.length === 0) {
        return res.status(400).json({
          error: '학습 자료 이미지 또는 텍스트를 업로드해 주세요.'
        });
      }

      let imageText = '';

      if (files.length > 0) {
        imageText = await extractTextFromImages(client, files);
      }

      const material = [
        typedText ? `[사용자 입력 자료]\n${typedText}` : '',
        imageText ? `[이미지 인식 자료]\n${imageText}` : ''
      ].filter(Boolean).join('\n\n').slice(0, MAX_TEXT_LENGTH);

      if (material.length < 10) {
        return res.status(422).json({
          error: '자료를 충분히 인식하지 못했습니다. 더 선명한 이미지나 텍스트를 올려 주세요.'
        });
      }

      const result = await createStudyResult(
        client,
        material,
        title,
        requestedCount
      );

      res.json({
        success: true,
        ...result,
        sourceText: material
      });
    } catch (error) {
      console.error('[STUDY ERROR]', error);

      res.status(error.status || 500).json({
        success: false,
        error: error.message || '학습 자료 분석 중 오류가 발생했습니다.',
        requestedQuestionCount: error.requestedCount,
        generatedQuestionCount: error.generatedCount
      });
    }
  }
);

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const client = getGroq();

    const message = cleanText(req.body.message, MAX_CHAT_LENGTH);
    const context = cleanText(req.body.context, MAX_TEXT_LENGTH);
    const history = Array.isArray(req.body.history)
      ? req.body.history.slice(-10)
      : [];

    if (!message) {
      return res.status(400).json({
        error: '질문을 입력해 주세요.'
      });
    }

    const messages = [
      {
        role: 'system',
        content: [
          '당신은 공부킬러의 학습 도우미입니다.',
          '수학, 국어, 영어, 과학, 사회, 역사 등 다양한 학습 질문에 답변하세요.',
          '중학생도 이해할 수 있도록 단계별로 설명하세요.',
          '수식은 읽기 쉽게 작성하세요.',
          '사용자가 자료를 제공했다면 해당 자료를 우선 참고하세요.',
          '자료에 없는 내용은 일반적인 지식으로 설명하되, 자료에 적힌 내용인 것처럼 말하지 마세요.',
          '모르는 내용은 모른다고 말하세요.'
        ].join('\n')
      },
      ...(context ? [{
        role: 'system',
        content: `현재 학습 자료:\n${context}`
      }] : []),
      ...history
        .filter(item =>
          item &&
          ['user', 'assistant'].includes(item.role) &&
          typeof item.content === 'string'
        )
        .map(item => ({
          role: item.role,
          content: cleanText(item.content, 4000)
        })),
      {
        role: 'user',
        content: message
      }
    ];

    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.5,
      max_completion_tokens: 3000
    });

    const answer = response.choices?.[0]?.message?.content || '';

    res.json({
      success: true,
      answer
    });
  } catch (error) {
    console.error('[CHAT ERROR]', error);

    res.status(500).json({
      success: false,
      error: error.message || '채팅 중 오류가 발생했습니다.'
    });
  }
});

app.use((error, req, res, next) => {
  console.error('[SERVER ERROR]', error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === 'LIMIT_FILE_SIZE'
        ? '이미지 한 장의 용량은 8MB 이하여야 합니다.'
        : '이미지 업로드 제한을 초과했습니다.'
    });
  }

  res.status(error.status || 500).json({
    error: error.message || '서버 오류가 발생했습니다.'
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`공부킬러 서버 실행 중: ${PORT}`);
  console.log(`텍스트 모델: ${MODEL}`);
  console.log(`이미지 인식 모델: ${VISION_MODEL}`);
});

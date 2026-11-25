
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
  process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

const MAX_TEXT_LENGTH = 30000;
const MAX_CHAT_LENGTH = 12000;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_IMAGES = 6;

const MAX_QUESTIONS = 100;
const QUESTIONS_PER_BATCH = 5;
const MAX_BATCH_ATTEMPTS = 3;

// ==========================================
// 1. 서버 기본 설정
// ==========================================

app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(express.json({
  limit: '2mb',
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ==========================================
// 2. 이미지 업로드
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_IMAGE_SIZE,
    files: MAX_IMAGES,
  },

  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (!allowed.includes(file.mimetype)) {
      const error = new Error(
        'JPG, PNG, WEBP 이미지 파일만 업로드할 수 있습니다.'
      );

      error.status = 400;
      return cb(error);
    }

    cb(null, true);
  },
});

// ==========================================
// 3. Groq 연결
// ==========================================

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    const error = new Error(
      '.env 파일에 GROQ_API_KEY를 설정해 주세요.'
    );

    error.status = 503;
    throw error;
  }

  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 120000,
    maxRetries: 0,
  });
}

// ==========================================
// 4. 공통 함수
// ==========================================

function getStatus(error) {
  return Number(
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    0
  );
}

function getResponseText(response) {
  const content = response?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text || '')
      .join('\n')
      .trim();
  }

  return '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.,!?'"`~·ㆍ:;()[\]{}<>]/g, '')
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();

  return values.filter(value => {
    const key = normalizeText(value);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

// ==========================================
// 5. Groq 요청 및 재시도
// ==========================================

async function callGroq(createRequest, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await createRequest();

    } catch (error) {
      lastError = error;

      const status = getStatus(error);

      console.error('Groq 오류:', {
        status,
        message: error.message,
        attempt: attempt + 1,
      });

      const retryable = [
        408,
        429,
        500,
        502,
        503,
        504,
      ].includes(status);

      if (!retryable || attempt >= retries) {
        throw error;
      }

      const delay = Math.min(
        5000 * (attempt + 1),
        15000
      );

      console.log(
        `${delay / 1000}초 후 재시도합니다.`
      );

      await sleep(delay);
    }
  }

  throw lastError || new Error('AI 요청에 실패했습니다.');
}

// ==========================================
// 6. JSON 파싱
// ==========================================

function parseJsonRobust(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('AI 응답이 비어 있습니다.');
  }

  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const first = text.indexOf('{');

  if (first < 0) {
    throw new Error('AI 응답에서 JSON을 찾지 못했습니다.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = first; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;

      if (depth === 0) {
        return JSON.parse(text.slice(first, i + 1));
      }
    }
  }

  throw new Error('AI JSON 응답이 완성되지 않았습니다.');
}

// ==========================================
// 7. AI JSON 생성
// ==========================================

async function requestStudyJson(groq, prompt, maxTokens = 5000) {
  const response = await callGroq(() =>
    groq.chat.completions.create({
      model: MODEL,

      messages: [
        {
          role: 'system',
          content: `
당신은 공부킬러의 전문 한국어 교사입니다.

반드시 유효한 JSON 객체만 출력하세요.
마크다운 코드블록을 사용하지 마세요.
JSON 앞뒤에 설명을 붙이지 마세요.
모든 문자열은 큰따옴표를 사용하세요.
요청한 JSON 필드를 빠뜨리지 마세요.
          `.trim(),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],

      temperature: 0.2,
      max_completion_tokens: maxTokens,
    })
  );

  const choice = response?.choices?.[0];

  if (!choice) {
    throw new Error('AI 응답을 받지 못했습니다.');
  }

  if (choice.finish_reason === 'length') {
    throw new Error(
      'AI 응답이 길이 제한으로 중단되었습니다. 다시 시도해 주세요.'
    );
  }

  const raw = getResponseText(response);

  if (!raw) {
    throw new Error('AI 답변 내용이 비어 있습니다.');
  }

  try {
    return parseJsonRobust(raw);

  } catch (error) {
    console.log('JSON 파싱 실패. 복구 요청을 진행합니다.');

    const repair = await callGroq(() =>
      groq.chat.completions.create({
        model: MODEL,

        messages: [
          {
            role: 'system',
            content:
              '당신은 JSON 복구 도구입니다. 설명 없이 유효한 JSON 객체만 출력하세요.',
          },
          {
            role: 'user',
            content: `
아래 내용을 올바른 JSON 객체로 복구하세요.

- 기존 정보를 삭제하지 마세요.
- 새로운 학습 정보를 지어내지 마세요.
- JSON 형식을 완성하세요.
- 설명은 출력하지 마세요.

[원본]
${raw}
            `.trim(),
          },
        ],

        temperature: 0,
        max_completion_tokens: maxTokens,
      })
    );

    const repairedText = getResponseText(repair);

    if (!repairedText) {
      throw new Error('AI JSON 복구에 실패했습니다.');
    }

    return parseJsonRobust(repairedText);
  }
}

// ==========================================
// 8. 사진 OCR
// ==========================================

async function extractTextFromImages(groq, images) {
  if (!images || images.length === 0) {
    return '';
  }

  const results = [];

  for (let i = 0; i < images.length; i++) {
    const file = images[i];

    console.log(`사진 분석: ${i + 1}/${images.length}`);

    const imageUrl =
      `data:${file.mimetype};base64,` +
      file.buffer.toString('base64');

    const response = await callGroq(() =>
      groq.chat.completions.create({
        model: VISION_MODEL,

        messages: [
          {
            role: 'system',
            content: `
당신은 학습 자료 OCR 전문가입니다.

사진에서 실제로 보이는 내용을 정확하게 읽으세요.

1. 한국어 글자를 정확하게 읽으세요.
2. 숫자와 수식을 그대로 기록하세요.
3. 문제와 보기를 구분하세요.
4. 예제와 풀이를 기록하세요.
5. 표와 그래프의 수치를 기록하세요.
6. 수학 기호와 단위를 보존하세요.
7. 판독할 수 없는 부분은 [판독 불가]라고 표시하세요.
8. 사진에 없는 내용을 만들지 마세요.
9. 원래 자료의 순서를 유지하세요.

일반 한국어 텍스트로 출력하세요.
            `.trim(),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '이 학습 자료의 모든 글자, 문제, 공식, 보기, 풀이를 읽어 주세요.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],

        temperature: 0.1,
        max_completion_tokens: 3000,
      })
    );

    const text = getResponseText(response);

    if (!text) {
      throw new Error(
        `${i + 1}번째 사진의 분석 결과가 비어 있습니다.`
      );
    }

    results.push(`[사진 ${i + 1}]\n${text}`);
  }

  return results.join('\n\n');
}

// ==========================================
// 9. 문제 검증
// ==========================================

function normalizeQuestion(question) {
  if (
    !question ||
    typeof question.question !== 'string' ||
    !question.question.trim()
  ) {
    return null;
  }

  if (
    !Array.isArray(question.options) ||
    question.options.length !== 5 ||
    !question.options.every(
      option => typeof option === 'string' && option.trim()
    )
  ) {
    return null;
  }

  const answer = Number(question.answer);

  if (
    !Number.isInteger(answer) ||
    answer < 0 ||
    answer > 4
  ) {
    return null;
  }

  if (
    typeof question.explanation !== 'string' ||
    !question.explanation.trim()
  ) {
    return null;
  }

  return {
    type: 'mcq',
    question: question.question.trim(),
    options: question.options.map(option => option.trim()),
    answer,
    explanation: question.explanation.trim(),
    sourceConcept: String(question.sourceConcept || ''),
    difficulty: String(question.difficulty || '보통'),
  };
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) {
    return [];
  }

  const result = [];
  const seen = new Set();

  for (const item of questions) {
    const question = normalizeQuestion(item);

    if (!question) {
      continue;
    }

    const key = normalizeText(question.question);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(question);
  }

  return result;
}

// ==========================================
// 10. 학습 자료 분석 결과 검증
// ==========================================

function normalizeStudyOverview(data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error('AI 분석 결과가 올바르지 않습니다.');
  }

  const summary = Array.isArray(data.summary)
    ? data.summary
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    : [];

  const keyTerms = Array.isArray(data.keyTerms)
    ? data.keyTerms
        .filter(item =>
          item &&
          typeof item.term === 'string' &&
          typeof item.meaning === 'string'
        )
        .map(item => ({
          term: item.term.trim(),
          meaning: item.meaning.trim(),
        }))
    : [];

  const reviewPoints = Array.isArray(data.reviewPoints)
    ? uniqueStrings(
        data.reviewPoints.filter(
          item => typeof item === 'string'
        )
      )
    : [];

  const solutions = Array.isArray(data.solutions)
    ? data.solutions
        .filter(item =>
          item &&
          typeof item.question === 'string'
        )
        .map(item => ({
          question: item.question,
          answer: String(item.answer || ''),
          solution: String(item.solution || ''),
          explanation: String(item.explanation || ''),
        }))
    : [];

  if (summary.length === 0) {
    throw new Error('핵심 정리를 만들지 못했습니다.');
  }

  return {
    title:
      typeof data.title === 'string' && data.title.trim()
        ? data.title.trim()
        : '나의 공부 자료',

    summary,
    keyTerms,
    reviewPoints,
    solutions,
  };
}

// ==========================================
// 11. 최초 학습 자료 분석
// ==========================================

async function createStudyOverview(groq, studyMaterial) {
  const prompt = `
다음 학습 자료를 분석하세요.

[학습 자료]
${studyMaterial}

[중요 규칙]

- 자료에 실제로 존재하는 내용만 분석하세요.
- 원본에 있는 개념, 공식, 정의를 정확히 파악하세요.
- 원본에 있는 문제와 풀이를 찾아 정리하세요.
- 자료에 없는 단원이나 개념을 추가하지 마세요.
- 사진에서 읽지 못한 부분은 추측하지 마세요.
- 요약은 학생이 시험 공부에 사용할 수 있도록 구체적으로 작성하세요.

[출력 형식]

{
  "title": "학습 자료 제목",
  "summary": [
    "핵심 개념과 설명",
    "공식과 적용 방법"
  ],
  "keyTerms": [
    {
      "term": "중요 용어",
      "meaning": "정확한 뜻"
    }
  ],
  "reviewPoints": [
    "시험에 중요한 내용"
  ],
  "solutions": [
    {
      "question": "원본에 있는 문제",
      "answer": "정답",
      "solution": "풀이 과정",
      "explanation": "쉽게 이해할 수 있는 설명"
    }
  ]
}

반드시 JSON 객체만 출력하세요.
`;

  const data = await requestStudyJson(
    groq,
    prompt,
    5000
  );

  return normalizeStudyOverview(data);
}

// ==========================================
// 12. 유사 문제 생성
// ==========================================

async function generateQuestionBatch(
  groq,
  studyMaterial,
  requestedCount,
  existingQuestions
) {
  const generated = [];
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_BATCH_ATTEMPTS &&
    generated.length < requestedCount;
    attempt++
  ) {
    const remaining = requestedCount - generated.length;

    const excludedQuestions = [
      ...existingQuestions,
      ...generated,
    ]
      .map((item, index) =>
        `${index + 1}. ${item.question}`
      )
      .join('\n');

    const prompt = `
당신은 공부킬러의 시험 문제 출제 전문가입니다.

아래 학습 자료를 정확하게 분석하고, 해당 자료와 같은 개념을 사용하는 새로운 유사 문제를 출제하세요.

[학습 자료 원본]
${studyMaterial}

[이미 생성된 문제 - 중복 출제 금지]
${excludedQuestions || '아직 생성된 문제가 없습니다.'}

[이번 생성 요청]
이번에는 정확히 ${remaining}개의 새로운 객관식 문제를 만드세요.

[출제 규칙]

1. 반드시 위 학습 자료를 기반으로 출제하세요.
2. 자료에 실제로 등장하는 개념, 공식, 정의, 풀이 유형을 사용하세요.
3. 원본 문제와 같은 유형이되 문제의 숫자, 조건, 보기, 상황을 바꿔 새로운 문제를 만드세요.
4. 단순히 원본 문제를 복사하지 마세요.
5. 자료에 없는 단원이나 개념을 출제하지 마세요.
6. 기존에 생성된 문제와 질문 내용이 겹치지 않게 하세요.
7. 숫자만 바꾼 문제도 정답과 풀이를 새로 검산하세요.
8. 모든 문제는 객관식 보기 5개를 사용하세요.
9. 정답 answer는 0부터 시작하는 정수입니다.
10. 정답은 반드시 보기 중 하나와 일치해야 합니다.
11. 오답 보기는 그럴듯하지만 틀린 답으로 작성하세요.
12. 모든 문제에 구체적인 해설을 작성하세요.
13. 문제의 난이도는 자료의 수준을 벗어나지 마세요.
14. 같은 질문을 표현만 바꿔 반복하지 마세요.
15. 요청한 개수를 채우기 어렵다면 억지로 자료에 없는 문제를 만들지 마세요.

[JSON 형식]

{
  "questions": [
    {
      "type": "mcq",
      "question": "새롭게 만든 유사 문제",
      "options": [
        "보기 1",
        "보기 2",
        "보기 3",
        "보기 4",
        "보기 5"
      ],
      "answer": 0,
      "explanation": "정답과 풀이를 단계별로 설명",
      "sourceConcept": "원본 자료의 참고 개념",
      "difficulty": "보통"
    }
  ]
}

중요: 이번 요청에서 필요한 문제 수는 ${remaining}개입니다.
반드시 JSON 객체만 출력하세요.
`;

    try {
      console.log(
        `유사 문제 생성: ${generated.length}/${requestedCount}개 완료, ${attempt}/${MAX_BATCH_ATTEMPTS}차 시도`
      );

      const data = await requestStudyJson(
        groq,
        prompt,
        5000
      );

      const batch = normalizeQuestions(data.questions);

      if (batch.length === 0) {
        throw new Error(
          'AI가 유효한 문제를 반환하지 않았습니다.'
        );
      }

      const seen = new Set([
        ...existingQuestions,
        ...generated,
      ].map(item => normalizeText(item.question)));

      for (const question of batch) {
        const key = normalizeText(question.question);

        if (!key || seen.has(key)) {
          continue;
        }

        seen.add(key);
        generated.push(question);

        if (generated.length >= requestedCount) {
          break;
        }
      }

      console.log(
        `이번 생성 결과: ${generated.length}/${requestedCount}개`
      );

    } catch (error) {
      lastError = error;

      console.error(
        '유사 문제 생성 오류:',
        error.message
      );

      if (getStatus(error) === 429) {
        break;
      }
    }
  }

  if (generated.length === 0 && lastError) {
    throw lastError;
  }

  return generated;
}

// ==========================================
// 13. 선택한 문제 수만큼 생성
// ==========================================

async function createStudyResult(
  groq,
  studyMaterial,
  requestedCount
) {
  console.log('학습 자료 분석 시작');

  const overview = await createStudyOverview(
    groq,
    studyMaterial
  );

  const allQuestions = [];

  let batchNumber = 0;

  while (allQuestions.length < requestedCount) {
    batchNumber++;

    const remaining = requestedCount - allQuestions.length;

    const batchSize = Math.min(
      QUESTIONS_PER_BATCH,
      remaining
    );

    console.log('-------------------------------');
    console.log(`문제 생성 묶음: ${batchNumber}`);
    console.log(`현재 문제: ${allQuestions.length}`);
    console.log(`이번 요청: ${batchSize}`);
    console.log(`목표 문제: ${requestedCount}`);
    console.log('-------------------------------');

    const batch = await generateQuestionBatch(
      groq,
      studyMaterial,
      batchSize,
      allQuestions
    );

    if (batch.length === 0) {
      console.error('추가 문제 생성 결과가 없습니다.');
      break;
    }

    allQuestions.push(...batch);

    console.log(
      `전체 진행: ${allQuestions.length}/${requestedCount}`
    );
  }

  if (allQuestions.length === 0) {
    throw new Error(
      '유사 문제를 만들지 못했습니다. 자료를 더 선명하게 등록해 주세요.'
    );
  }

  const complete = allQuestions.length >= requestedCount;

  return {
    ...overview,
    questions: allQuestions.slice(0, requestedCount),
    requestedQuestionCount: requestedCount,
    generatedQuestionCount: allQuestions.length,
    questionCountComplete: complete,
    questionGenerationWarning: complete
      ? ''
      : `자료 또는 AI 응답 제한으로 ${requestedCount}문제 중 ${allQuestions.length}문제만 생성되었습니다. 부족한 문제는 자료를 확인한 뒤 다시 생성해 주세요.`,
  };
}

// ==========================================
// 14. 서버 상태 확인
// ==========================================

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.GROQ_API_KEY),
    model: MODEL,
    visionModel: VISION_MODEL,
    maxImages: MAX_IMAGES,
    maxQuestions: MAX_QUESTIONS,
    questionsPerBatch: QUESTIONS_PER_BATCH,
  });
});

// ==========================================
// 15. 공부 자료 분석 API
// ==========================================

app.post(
  '/api/study',
  upload.array('images', MAX_IMAGES),

  async (req, res, next) => {
    try {
      const typedText = String(req.body.text || '')
        .trim()
        .slice(0, MAX_TEXT_LENGTH);

      const requestedCount = clampNumber(
        req.body.questionCount,
        1,
        MAX_QUESTIONS,
        10
      );

      const images = req.files || [];

      if (!typedText && images.length === 0) {
        return res.status(400).json({
          error: '공부 내용이나 사진을 등록해 주세요.',
        });
      }

      const groq = getGroqClient();

      console.log('================================');
      console.log('공부 자료 분석 시작');
      console.log('사진:', images.length);
      console.log('입력 글자:', typedText.length);
      console.log('요청 문제 수:', requestedCount);
      console.log('================================');

      let imageText = '';

      if (images.length > 0) {
        try {
          imageText = await extractTextFromImages(
            groq,
            images
          );

        } catch (error) {
          console.error(
            '사진 분석 실패:',
            error.message
          );

          throw new Error(
            `사진 분석 실패: ${error.message}`
          );
        }
      }

      const studyMaterial = [
        typedText
          ? `[직접 입력한 학습 내용]\n${typedText}`
          : '',

        imageText
          ? `[사진에서 읽은 학습 내용]\n${imageText}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, MAX_TEXT_LENGTH);

      if (!studyMaterial.trim()) {
        throw new Error(
          '학습 자료를 읽지 못했습니다.'
        );
      }

      console.log('최종 학습 자료 길이:', studyMaterial.length);

      const result = await createStudyResult(
        groq,
        studyMaterial,
        requestedCount
      );

      console.log('================================');
      console.log('학습 자료 생성 완료');
      console.log('요청 문제:', requestedCount);
      console.log('생성 문제:', result.questions.length);
      console.log('완료 여부:', result.questionCountComplete);
      console.log('================================');

      return res.json({
        ...result,
        studyMaterial,
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// 16. AI 선생님 대화 API
// ==========================================

app.post('/api/chat', async (req, res, next) => {
  try {
    const studyMaterial = String(
      req.body.studyMaterial || ''
    )
      .trim()
      .slice(0, MAX_CHAT_LENGTH);

    const userMessage = String(
      req.body.message || ''
    )
      .trim()
      .slice(0, 3000);

    const start = req.body.start === true;

    const incomingMessages = Array.isArray(req.body.messages)
      ? req.body.messages
      : [];

    if (!studyMaterial) {
      return res.status(400).json({
        error: '먼저 공부 자료를 등록해 주세요.',
      });
    }

    if (
      !userMessage &&
      incomingMessages.length === 0 &&
      !start
    ) {
      return res.status(400).json({
        error: '질문 내용을 입력해 주세요.',
      });
    }

    const safeMessages = incomingMessages
      .slice(-10)
      .filter(item =>
        item &&
        ['user', 'assistant'].includes(item.role) &&
        typeof item.content === 'string'
      )
      .map(item => ({
        role: item.role,
        content: item.content.slice(0, 2000),
      }));

    const last = safeMessages[safeMessages.length - 1];

    if (
      userMessage &&
      !(
        last?.role === 'user' &&
        last?.content === userMessage
      )
    ) {
      safeMessages.push({
        role: 'user',
        content: userMessage,
      });
    }

    const groq = getGroqClient();

    const response = await callGroq(() =>
      groq.chat.completions.create({
        model: MODEL,

        messages: [
          {
            role: 'system',
            content: `
당신은 공부킬러의 AI 선생님입니다.

항상 자연스러운 한국어 존댓말을 사용하세요.

[학습 자료]
${studyMaterial}

[규칙]

1. 등록된 자료를 기준으로 설명하세요.
2. 자료에 없는 내용은 확인되지 않는다고 말하세요.
3. 학생의 질문에 먼저 답하세요.
4. 학생이 문제를 풀면 정답인지 확인하세요.
5. 오답이면 정답과 풀이를 쉽게 설명하세요.
6. 정답이면 칭찬하고 다음 문제를 제시하세요.
7. 한 번에 질문 하나만 하세요.
8. 원본과 비슷한 응용 문제를 우선 출제하세요.
            `.trim(),
          },

          ...safeMessages,
        ],

        temperature: 0.3,
        max_completion_tokens: 1500,
      })
    );

    const reply = getResponseText(response);

    if (!reply) {
      throw new Error(
        'AI 답변이 비어 있습니다. 다시 질문해 주세요.'
      );
    }

    return res.json({
      reply,
    });

  } catch (error) {
    next(error);
  }
});

// ==========================================
// 17. 없는 API 경로
// ==========================================

app.use('/api/', (_req, res) => {
  res.status(404).json({
    error: '요청한 API를 찾을 수 없습니다.',
  });
});

// ==========================================
// 18. 전체 오류 처리
// ==========================================

app.use((error, _req, res, _next) => {
  let status = getStatus(error) || 500;
  let message = error.message || '서버 오류가 발생했습니다.';

  console.error('================================');
  console.error('서버 오류:', status);
  console.error('상세 내용:', message);
  console.error('================================');

  if (error instanceof multer.MulterError) {
    status = 400;

    if (error.code === 'LIMIT_FILE_SIZE') {
      message = '사진 한 장의 용량은 8MB 이하여야 합니다.';
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      message = '사진은 최대 6장까지 등록할 수 있습니다.';
    } else {
      message = '이미지 업로드 중 오류가 발생했습니다.';
    }
  }

  if (status === 401 || status === 403) {
    message = 'Groq API 키 또는 권한을 확인해 주세요.';
  } else if (status === 404) {
    message = 'AI 모델 이름을 확인해 주세요.';
  } else if (status === 413) {
    message = '전송 데이터가 너무 큽니다.';
  } else if (status === 429) {
    message = 'AI 사용량 제한입니다. 잠시 후 다시 시도해 주세요.';
  } else if (status === 503) {
    message = error.message || 'AI 서비스를 사용할 수 없습니다.';
  }

  return res.status(status).json({
    error: message,
  });
});

// ==========================================
// 19. 서버 실행
// ==========================================

app.listen(PORT, () => {
  console.log('================================');
  console.log('공부킬러 서버 실행 완료!');
  console.log(`주소: http://localhost:${PORT}`);
  console.log(`텍스트 모델: ${MODEL}`);
  console.log(`이미지 모델: ${VISION_MODEL}`);
  console.log(`최대 문제 수: ${MAX_QUESTIONS}`);
  console.log(`한 번에 생성하는 문제: ${QUESTIONS_PER_BATCH}`);
  console.log('================================');
});

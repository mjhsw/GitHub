
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
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

const MAX_TEXT_LENGTH = 12000;
const MAX_CHAT_LENGTH = 12000;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_IMAGES = 6;

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
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ==========================================
// 1. 이미지 업로드 설정
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
// 2. Groq API 연결
// ==========================================

function getApiKey() {
  return (
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
}

function getGroqClient() {
  const apiKey = getApiKey();

  if (!apiKey) {
    const error = new Error(
      '.env 또는 Render 환경 변수에 GROQ_API_KEY를 설정해 주세요.'
    );

    error.status = 503;
    throw error;
  }

  return new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 120000,
    maxRetries: 0,
  });
}

// ==========================================
// 3. 공통 함수
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
      .filter(item => item?.type === 'text')
      .map(item => item.text || '')
      .join('\n')
      .trim();
  }

  return '';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 4. AI 요청 재시도
// ==========================================

async function callGroq(createRequest, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await createRequest();
    } catch (error) {
      const status = getStatus(error);

      const retryable = [
        429,
        500,
        502,
        503,
        504,
      ].includes(status);

      if (!retryable || attempt === retries) {
        throw error;
      }

      const delay = Math.min(
        5000 * (attempt + 1),
        15000
      );

      console.warn(
        `Groq 오류 ${status}. ${delay / 1000}초 후 재시도합니다.`
      );

      await sleep(delay);
    }
  }

  throw new Error('AI 요청에 실패했습니다.');
}

// ==========================================
// 5. JSON 파싱
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
    throw new Error(
      'AI 응답에서 JSON 객체를 찾지 못했습니다.'
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = first; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;

      if (depth === 0) {
        return JSON.parse(
          text.slice(first, i + 1)
        );
      }
    }
  }

  throw new Error(
    'AI JSON 응답이 완성되지 않았습니다.'
  );
}

// ==========================================
// 6. 학습 자료 JSON 생성
// ==========================================

async function requestStudyJson(groq, prompt) {
  const response = await callGroq(() =>
    groq.chat.completions.create({
      model: MODEL,

      messages: [
        {
          role: 'system',
          content: `
당신은 정확한 교육 자료 제작자입니다.

반드시 유효한 JSON 객체만 출력하세요.
마크다운 코드블록이나 JSON 바깥 설명은 출력하지 마세요.
          `,
        },

        {
          role: 'user',
          content: prompt,
        },
      ],

      temperature: 0.1,
      max_completion_tokens: 6000,
    })
  );

  const choice = response?.choices?.[0];

  if (!choice) {
    throw new Error('AI 응답을 받지 못했습니다.');
  }

  if (choice.finish_reason === 'length') {
    throw new Error(
      'AI 답변이 길어 중단되었습니다. 문제 수를 줄여 다시 시도해 주세요.'
    );
  }

  const raw = getResponseText(response);

  if (!raw) {
    throw new Error('AI 답변 내용이 비어 있습니다.');
  }

  try {
    return parseJsonRobust(raw);
  } catch {
    const repaired = await callGroq(() =>
      groq.chat.completions.create({
        model: MODEL,

        messages: [
          {
            role: 'system',
            content:
              '당신은 JSON 복구 도구입니다. 원래 내용을 최대한 유지하고 유효한 JSON 객체만 출력하세요.',
          },

          {
            role: 'user',
            content:
              `아래 내용을 유효한 JSON 객체로 복구하세요. 설명은 쓰지 마세요.\n\n${raw}`,
          },
        ],

        temperature: 0,
        max_completion_tokens: 6000,
      })
    );

    return parseJsonRobust(
      getResponseText(repaired)
    );
  }
}

// ==========================================
// 7. 사진 OCR
// ==========================================

async function extractTextFromImages(groq, images) {
  const results = [];

  for (let i = 0; i < images.length; i++) {
    const file = images[i];

    const dataUrl =
      `data:${file.mimetype};base64,` +
      file.buffer.toString('base64');

    const response = await callGroq(() =>
      groq.chat.completions.create({
        model: VISION_MODEL,

        messages: [
          {
            role: 'system',
            content: [
              '당신은 학습 자료 OCR 전문가입니다.',
              '사진에 실제로 보이는 글자, 숫자, 수식, 문제, 보기, 표, 풀이만 정확히 추출하세요.',
              '사진에 없는 내용을 만들지 마세요.',
              '읽기 어려운 곳은 [판독 불가]라고 표시하세요.',
              '수식과 기호는 가능한 한 원형을 유지하고 한국어로 출력하세요.',
            ].join('\n'),
          },

          {
            role: 'user',

            content: [
              {
                type: 'text',
                text:
                  `학습 자료 사진 ${i + 1}번의 내용을 빠짐없이 읽어 주세요.`,
              },

              {
                type: 'image_url',
                image_url: {
                  url: dataUrl,
                },
              },
            ],
          },
        ],

        temperature: 0.1,
        max_completion_tokens: 2500,
      })
    );

    const text = getResponseText(response);

    if (!text) {
      throw new Error(
        `${i + 1}번째 사진을 읽지 못했습니다. 더 선명한 사진으로 다시 등록해 주세요.`
      );
    }

    results.push(
      `[사진 ${i + 1}]\n${text}`
    );
  }

  return results.join('\n\n');
}

// ==========================================
// 8. 학습 데이터 검증
// ==========================================

function normalizeStudyData(data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error(
      'AI 분석 결과가 올바르지 않습니다.'
    );
  }

  const summary = Array.isArray(data.summary)
    ? data.summary
        .filter(x => typeof x === 'string' && x.trim())
        .map(x => x.trim())
    : [];

  const keyTerms = Array.isArray(data.keyTerms)
    ? data.keyTerms
        .filter(x =>
          x &&
          typeof x.term === 'string' &&
          typeof x.meaning === 'string'
        )
        .map(x => ({
          term: x.term,
          meaning: x.meaning,
        }))
    : [];

  const reviewPoints = Array.isArray(data.reviewPoints)
    ? data.reviewPoints.filter(
        x => typeof x === 'string'
      )
    : [];

  const solutions = Array.isArray(data.solutions)
    ? data.solutions
        .filter(x =>
          x &&
          typeof x.question === 'string'
        )
        .map(x => ({
          question: x.question,
          answer: String(x.answer ?? ''),
          solution: String(x.solution ?? ''),
          explanation: String(x.explanation ?? ''),
        }))
    : [];

  const questions = Array.isArray(data.questions)
    ? data.questions
        .filter(q =>
          q &&
          typeof q.question === 'string' &&
          Array.isArray(q.options) &&
          q.options.length === 5 &&
          q.options.every(x => typeof x === 'string') &&
          Number.isInteger(q.answer) &&
          q.answer >= 0 &&
          q.answer < 5
        )
        .map(q => ({
          type: 'mcq',
          question: q.question,
          options: q.options,
          answer: q.answer,
          explanation: String(q.explanation || ''),
          sourceConcept: String(q.sourceConcept || ''),
          difficulty: String(q.difficulty || '보통'),
        }))
    : [];

  if (!summary.length) {
    throw new Error(
      '핵심 정리를 만들지 못했습니다. 자료를 다시 등록해 주세요.'
    );
  }

  if (!questions.length) {
    throw new Error(
      '문제를 만들지 못했습니다. 더 선명한 자료를 등록하거나 다시 시도해 주세요.'
    );
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
    questions,
  };
}

// ==========================================
// 9. 학습 자료 분석 및 문제 생성
// ==========================================

async function createStudyResult(
  groq,
  studyMaterial,
  questionCount = 10
) {
  const count = Math.min(
    50,
    Math.max(5, Number(questionCount) || 10)
  );

  const prompt = `
다음 학습 자료를 분석하여 시험 대비 학습 자료를 만드세요.

[학습 자료]
${studyMaterial}

[작성 원칙]
- 자료에 있는 개념, 공식, 용어를 정확히 정리하세요.
- 원본에 실제로 있는 문제의 풀이와 정답을 기록하세요.
- 원본과 같은 개념과 풀이법을 사용하는 새로운 응용 문제를 만드세요.
- 자료에 없는 단원이나 사실을 원본에 있는 것처럼 꾸며내지 마세요.
- 문제는 ${count}개를 목표로 생성하되, 자료가 부족하면 가능한 수만 생성하세요.
- 객관식은 보기 5개로 작성하고 answer는 0부터 시작하는 정수 인덱스로 작성하세요.
- 모든 문제의 정답과 해설을 검산하세요.
- 수학 수식은 올바른 LaTeX 문법을 사용하세요.
- 한글은 \\text{내용} 형태로 작성하세요.
- 결과는 반드시 JSON 객체만 출력하세요.

[JSON 형식]
{
  "title": "학습 자료 제목",
  "summary": ["핵심 정리"],
  "keyTerms": [
    {
      "term": "용어",
      "meaning": "뜻"
    }
  ],
  "reviewPoints": ["복습할 내용"],
  "solutions": [
    {
      "question": "원본 문제",
      "answer": "정답",
      "solution": "단계별 풀이",
      "explanation": "설명"
    }
  ],
  "questions": [
    {
      "type": "mcq",
      "question": "새로운 유사 문제",
      "options": [
        "보기1",
        "보기2",
        "보기3",
        "보기4",
        "보기5"
      ],
      "answer": 0,
      "explanation": "정답 해설",
      "sourceConcept": "참고 개념",
      "difficulty": "보통"
    }
  ]
}
`;

  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await requestStudyJson(
        groq,
        prompt
      );

      return normalizeStudyData(data);
    } catch (error) {
      lastError = error;

      console.error(
        `학습 자료 생성 ${attempt}차 실패:`,
        error.message
      );
    }
  }

  throw lastError ||
    new Error('학습 자료 생성에 실패했습니다.');
}

// ==========================================
// 10. 서버 상태 확인
// ==========================================

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(getApiKey()),
    model: MODEL,
    visionModel: VISION_MODEL,

    features: [
      'all-subject-chat',
      'multilingual-chat',
      'level-adaptation',
      'image-ocr',
      'study-summary',
      'quiz-generation',
    ],
  });
});

// ==========================================
// 11. 공부 자료 분석 API
// ==========================================

app.post(
  '/api/study',
  upload.array('images', MAX_IMAGES),

  async (req, res, next) => {
    try {
      const typedText = String(
        req.body.text || ''
      )
        .trim()
        .slice(0, MAX_TEXT_LENGTH);

      const images = req.files || [];

      if (!typedText && images.length === 0) {
        return res.status(400).json({
          error:
            '공부 내용이나 사진을 등록해 주세요.',
        });
      }

      const groq = getGroqClient();

      console.log(
        `학습 자료 분석 시작: 사진 ${images.length}장, 입력 ${typedText.length}자`
      );

      const imageText = images.length
        ? await extractTextFromImages(groq, images)
        : '';

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
          '등록한 학습 자료를 읽지 못했습니다.'
        );
      }

      const result = await createStudyResult(
        groq,
        studyMaterial,
        req.body.questionCount
      );

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
// 12. 전 과목 AI 선생님
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
      .slice(0, 5000);

    const subject = String(
      req.body.subject || '전체 과목'
    )
      .trim()
      .slice(0, 100);

    const language = String(
      req.body.language || '질문 언어에 맞춰 답변'
    )
      .trim()
      .slice(0, 100);

    const level = String(
      req.body.level || '학생 수준에 맞춰 설명'
    )
      .trim()
      .slice(0, 100);

    const start = req.body.start === true;

    const incoming = Array.isArray(req.body.messages)
      ? req.body.messages
      : [];

    const messages = incoming
      .slice(-16)
      .filter(item =>
        item &&
        ['user', 'assistant'].includes(item.role) &&
        typeof item.content === 'string'
      )
      .map(item => ({
        role: item.role,
        content: item.content.slice(0, 3000),
      }));

    const last = messages[messages.length - 1];

    if (
      userMessage &&
      !(
        last?.role === 'user' &&
        last.content === userMessage
      )
    ) {
      messages.push({
        role: 'user',
        content: userMessage,
      });
    }

    if (!messages.length && !start) {
      return res.status(400).json({
        error: '질문 내용을 입력해 주세요.',
      });
    }

    const systemPrompt = `
당신은 공부킬러의 종합 AI 교육 선생님입니다.

과목이나 언어에 관계없이 학생의 질문을 이해하고
정확하고 친절하게 가르치세요.

━━━━━━━━━━━━━━━━━━━━
[지원 교육 분야]
━━━━━━━━━━━━━━━━━━━━

국어:
문학, 독서, 문법, 작문, 화법, 어휘, 비문학.

수학:
산수, 정수, 유리수, 대수, 방정식, 함수,
기하, 미적분, 확률, 통계, 선형대수, 수론.

영어:
문법, 독해, 작문, 회화, 어휘, 발음, 영작.

과학:
물리학, 화학, 생명과학, 지구과학,
천문학, 환경과학, 생태학.

사회:
사회문화, 정치, 경제, 법, 지리, 윤리, 철학.

역사:
한국사, 세계사, 동양사, 서양사,
고대사, 중세사, 근현대사.

정보:
컴퓨터, 프로그래밍, 알고리즘, 데이터베이스,
인공지능, 웹 개발, 네트워크, 정보 보안 기초.

기타:
음악, 미술, 체육, 기술, 가정, 금융 기초,
직업 교육, 자격증, 대학 전공, 일반 교양.

━━━━━━━━━━━━━━━━━━━━
[다국어 지원]
━━━━━━━━━━━━━━━━━━━━

한국어, 영어, 중국어, 일본어, 스페인어,
프랑스어, 독일어, 러시아어, 아랍어,
베트남어, 태국어, 이탈리아어, 포르투갈어,
힌디어 및 기타 언어를 지원하세요.

사용자가 요청한 답변 언어를 따르세요.
자동 감지라면 질문 언어를 사용하세요.
번역은 원문의 뜻과 문맥을 보존하세요.

━━━━━━━━━━━━━━━━━━━━
[수준별 설명]
━━━━━━━━━━━━━━━━━━━━

초등:
쉬운 말과 생활 예시를 사용하세요.

중등:
기초 개념과 원리를 설명하세요.

고등:
교과 과정과 시험 수준에 맞춰 설명하세요.

대학:
전공 개념과 전문 용어를 사용하세요.

전문가:
심화 원리와 엄밀한 설명을 제공하세요.

자동 맞춤이면 질문의 난이도에 맞추세요.

━━━━━━━━━━━━━━━━━━━━
[수학 설명]
━━━━━━━━━━━━━━━━━━━━

조건 정리 → 공식 → 단계별 계산 → 최종 답 순서로 설명하세요.

중간 계산을 생략하지 말고 가능한 경우 검산하세요.

수식은 LaTeX로 작성하고 한글 텍스트는
\\text{내용} 형식을 사용하세요.

━━━━━━━━━━━━━━━━━━━━
[외국어 설명]
━━━━━━━━━━━━━━━━━━━━

필요하면 다음 내용을 함께 제공하세요.

- 원문
- 한국어 번역
- 핵심 단어
- 문법 설명
- 발음 안내
- 자연스러운 예문

━━━━━━━━━━━━━━━━━━━━
[코딩 교육]
━━━━━━━━━━━━━━━━━━━━

언어와 실행 환경을 확인하세요.

실제 문법에 맞는 코드를 작성하세요.

코드가 길면 파일별로 구분하고 실행 방법,
오류 원인, 해결 방법을 설명하세요.

존재하지 않는 API나 라이브러리를 지어내지 마세요.

━━━━━━━━━━━━━━━━━━━━
[학습 자료 활용]
━━━━━━━━━━━━━━━━━━━━

아래에 학습 자료가 제공되면 관련 질문에 우선 참고하세요.

자료가 없거나 질문이 자료와 무관하더라도
일반 교육 지식으로 답변하세요.

자료에서 확인된 사실과 일반 지식을 구분하세요.

자료가 없다는 이유로 답변을 거절하지 마세요.

━━━━━━━━━━━━━━━━━━━━
[정확성 및 대화]
━━━━━━━━━━━━━━━━━━━━

질문에 먼저 직접 답하고 필요한 설명을 덧붙이세요.

어려운 용어는 정의와 예시를 제공하세요.

불확실한 사실은 확실하지 않다고 말하고 지어내지 마세요.

기본 답변은 자연스러운 한국어 존댓말로 하되
사용자가 다른 언어를 요청하면 해당 언어로 답변하세요.

━━━━━━━━━━━━━━━━━━━━
[현재 학습 설정]
━━━━━━━━━━━━━━━━━━━━

과목: ${subject}
답변 언어: ${language}
학습 수준: ${level}

━━━━━━━━━━━━━━━━━━━━
[등록된 학습 자료]
━━━━━━━━━━━━━━━━━━━━

${studyMaterial || '등록된 학습 자료 없음. 일반 교육 질문에 자유롭게 답변하세요.'}
`;

    const groq = getGroqClient();

    const response = await callGroq(() =>
      groq.chat.completions.create({
        model: MODEL,

        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },

          ...messages,
        ],

        temperature: 0.3,
        max_completion_tokens: 3000,
      })
    );

    const reply = getResponseText(response);

    if (!reply) {
      throw new Error(
        'AI 답변을 받지 못했습니다. 다시 질문해 주세요.'
      );
    }

    return res.json({
      reply,
      subject,
      language,
      level,
    });

  } catch (error) {
    next(error);
  }
});

// ==========================================
// 13. 잘못된 API 경로
// ==========================================

app.use('/api/', (_req, res) => {
  res.status(404).json({
    error: '요청한 API를 찾을 수 없습니다.',
  });
});

// ==========================================
// 14. 전체 오류 처리
// ==========================================

app.use((error, _req, res, _next) => {
  let status = getStatus(error) || 500;

  let message =
    error?.message ||
    '서버 오류가 발생했습니다.';

  if (error instanceof multer.MulterError) {
    status = 400;

    if (error.code === 'LIMIT_FILE_SIZE') {
      message =
        '사진 한 장의 용량은 8MB 이하여야 합니다.';
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      message =
        `사진은 최대 ${MAX_IMAGES}장까지 등록할 수 있습니다.`;
    } else {
      message =
        '이미지 업로드 형식이 올바르지 않습니다.';
    }

  } else if (status === 401 || status === 403) {
    message =
      'Groq API 키가 잘못되었거나 사용 권한이 없습니다. Render 환경 변수를 확인해 주세요.';

  } else if (status === 404) {
    message =
      'AI 모델을 찾을 수 없습니다. GROQ_MODEL 또는 GROQ_VISION_MODEL을 확인해 주세요.';

  } else if (status === 413) {
    message =
      '전송 데이터가 너무 큽니다. 사진 수나 용량을 줄여 주세요.';

  } else if (status === 429) {
    message =
      'AI 사용량 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.';

  } else if (status >= 500 && status !== 503) {
    message =
      'AI 처리 중 서버 오류가 발생했습니다. Render Logs에서 상세 내용을 확인해 주세요.';
  }

  console.error(
    '서버 오류:',
    status,
    error?.message || error
  );

  return res.status(status).json({
    error: message,
  });
});

// ==========================================
// 15. 서버 실행
// ==========================================

app.listen(PORT, () => {
  console.log('================================');
  console.log('공부킬러 서버 실행 완료!');
  console.log(`주소: http://localhost:${PORT}`);
  console.log(`텍스트 모델: ${MODEL}`);
  console.log(`이미지 모델: ${VISION_MODEL}`);
  console.log(
    `Groq API 키: ${getApiKey() ? '설정됨' : '설정되지 않음'}`
  );
  console.log('================================');
});

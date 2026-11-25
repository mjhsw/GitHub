
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

const MODEL =
  process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

const MAX_TEXT_LENGTH = 12000;
const MAX_CHAT_LENGTH = 12000;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_IMAGES = 6;

app.disable('x-powered-by');

console.log('공부킬러 서버 준비 중...');

// ==========================================
// 1. 기본 서버 설정
// ==========================================

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(express.json({
  limit: '2mb',
}));

app.use(express.static(
  path.join(__dirname, 'public')
));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ==========================================
// 2. 이미지 업로드 설정
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_IMAGE_SIZE,
    files: MAX_IMAGES,
  },

  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (!allowedTypes.includes(file.mimetype)) {
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

function getApiKey() {
  return String(
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
}

function getGroqClient() {
  const apiKey = getApiKey();

  if (!apiKey) {
    const error = new Error(
      'Groq API 키가 설정되지 않았습니다.'
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
  const content =
    response?.choices?.[0]?.message?.content;

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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// 5. AI 요청 재시도
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

      const delay = 5000 * (attempt + 1);

      console.warn(
        `Groq 오류 ${status}. ${delay / 1000}초 후 재시도`
      );

      await wait(delay);
    }
  }

  throw new Error('AI 요청에 실패했습니다.');
}

// ==========================================
// 6. JSON 파싱
// ==========================================

function parseJsonRobust(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('AI 응답이 비어 있습니다.');
  }

  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = cleaned.indexOf('{');

  if (start === -1) {
    throw new Error('AI JSON 시작 부분을 찾지 못했습니다.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];

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
        return JSON.parse(
          cleaned.slice(start, i + 1)
        );
      }
    }
  }

  throw new Error('AI JSON 응답이 완성되지 않았습니다.');
}

// ==========================================
// 7. 사진 OCR - 가장 중요한 수정 부분
// ==========================================

async function extractTextFromImages(groq, images) {
  if (!Array.isArray(images) || images.length === 0) {
    return '';
  }

  const results = [];

  console.log(
    `사진 인식 시작: 총 ${images.length}장`
  );

  // Qwen 비전 모델의 이미지 요청 제한을 피하기 위해
  // 사진을 반드시 한 장씩 처리합니다.
  for (let i = 0; i < images.length; i++) {
    const file = images[i];

    if (!file?.buffer || !file.mimetype) {
      throw new Error(
        `${i + 1}번째 사진 파일이 올바르지 않습니다.`
      );
    }

    if (![
      'image/jpeg',
      'image/png',
      'image/webp',
    ].includes(file.mimetype)) {
      throw new Error(
        `${i + 1}번째 사진의 형식이 지원되지 않습니다.`
      );
    }

    console.log(
      `사진 ${i + 1}/${images.length} 인식 중...`
    );

    const base64 = file.buffer.toString('base64');

    const dataUrl =
      `data:${file.mimetype};base64,${base64}`;

    let response;

    try {
      response = await callGroq(() =>
        groq.chat.completions.create({
          model: VISION_MODEL,

          messages: [
            {
              role: 'system',

              content: `
당신은 대한민국 학교 교과서와 학습지를 읽는 전문 OCR 선생님입니다.

사진에 실제로 보이는 내용을 정확하게 추출하세요.

[인식 규칙]

1. 한국어 문장을 정확히 읽으세요.
2. 영어와 외국어도 가능한 한 그대로 추출하세요.
3. 숫자, 기호, 수학 공식은 생략하지 마세요.
4. 문제 번호와 보기 번호를 유지하세요.
5. 표와 그래프의 제목과 수치를 읽으세요.
6. 문제와 정답, 해설을 구분하세요.
7. 수학 기호를 임의로 변경하지 마세요.
8. 사진에 없는 내용을 만들어내지 마세요.
9. 읽을 수 없는 부분은 [판독 불가]라고 쓰세요.
10. 사진의 내용을 요약하지 말고 최대한 원문 그대로 추출하세요.

결과는 한국어로 작성하세요.
              `,
            },

            {
              role: 'user',

              content: [
                {
                  type: 'text',
                  text:
                    `이 학습 자료 사진 ${i + 1}번의 글자와 내용을 정확하게 추출해 주세요.`,
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

          temperature: 0.2,
          max_completion_tokens: 3000,
        })
      );

    } catch (error) {
      console.error(
        `사진 ${i + 1} OCR 오류:`,
        error.message
      );

      const status = getStatus(error);

      throw new Error(
        `사진 ${i + 1} 인식 실패 (${status || '네트워크 오류'}): ${error.message}`
      );
    }

    const extracted = getResponseText(response);

    if (!extracted) {
      throw new Error(
        `사진 ${i + 1}에서 글자를 읽지 못했습니다. 사진을 더 선명하게 촬영해 주세요.`
      );
    }

    results.push(
      `===== 사진 ${i + 1} 인식 결과 =====\n${extracted}`
    );

    console.log(
      `사진 ${i + 1} 인식 완료: ${extracted.length}자`
    );
  }

  return results.join('\n\n');
}

// ==========================================
// 8. 문제 보기 섞기
// ==========================================

function shuffleQuestionOptions(question) {
  const options = [...question.options];

  const correctAnswer = options[question.answer];

  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [options[i], options[j]] =
      [options[j], options[i]];
  }

  return {
    ...question,
    options,
    answer: options.indexOf(correctAnswer),
  };
}

// ==========================================
// 9. AI 학습 데이터 검증
// ==========================================

function normalizeStudyData(data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error('AI 분석 결과가 올바르지 않습니다.');
  }

  const result = {
    title:
      typeof data.title === 'string' && data.title.trim()
        ? data.title.trim()
        : '나의 공부 자료',

    summary: Array.isArray(data.summary)
      ? data.summary.filter(
          item => typeof item === 'string' && item.trim()
        )
      : [],

    keyTerms: Array.isArray(data.keyTerms)
      ? data.keyTerms.filter(item =>
          item &&
          typeof item.term === 'string' &&
          typeof item.meaning === 'string'
        )
      : [],

    reviewPoints: Array.isArray(data.reviewPoints)
      ? data.reviewPoints.filter(
          item => typeof item === 'string'
        )
      : [],

    solutions: Array.isArray(data.solutions)
      ? data.solutions.filter(item =>
          item &&
          typeof item.question === 'string'
        )
      : [],

    questions: Array.isArray(data.questions)
      ? data.questions
          .filter(question =>
            question &&
            typeof question.question === 'string' &&
            Array.isArray(question.options) &&
            question.options.length === 5 &&
            question.options.every(
              option => typeof option === 'string'
            ) &&
            Number.isInteger(question.answer) &&
            question.answer >= 0 &&
            question.answer < 5 &&
            typeof question.explanation === 'string'
          )
          .map(shuffleQuestionOptions)
      : [],
  };

  if (result.summary.length === 0) {
    throw new Error(
      '핵심 정리를 만들지 못했습니다. 자료를 다시 등록해 주세요.'
    );
  }

  if (result.questions.length === 0) {
    throw new Error(
      '예상 문제를 만들지 못했습니다. 다시 시도해 주세요.'
    );
  }

  return result;
}

// ==========================================
// 10. 학습 자료 분석
// ==========================================

async function analyzeStudyMaterial(
  groq,
  studyMaterial,
  questionCount
) {
  const count = Math.min(
    50,
    Math.max(5, Number(questionCount) || 10)
  );

  const prompt = `
다음 학습 자료를 분석하세요.

[학습 자료]
${studyMaterial}

[요구 사항]

1. 자료의 제목을 작성하세요.
2. 핵심 개념과 공식을 정리하세요.
3. 주요 용어와 뜻을 정리하세요.
4. 시험에 중요한 내용을 정리하세요.
5. 원본 자료에 있는 예제의 풀이를 작성하세요.
6. 원본 자료의 개념을 활용한 새로운 유사 문제를 만드세요.
7. 자료에 없는 사실을 원본 내용처럼 만들지 마세요.
8. 객관식 문제는 보기 5개를 작성하세요.
9. answer는 정답 보기의 0부터 시작하는 인덱스입니다.
10. 모든 문제의 정답과 해설을 작성하세요.
11. 수학 문제는 계산 과정을 정확하게 작성하세요.
12. 목표 문제 수는 ${count}개입니다.
13. 자료가 부족하면 무리하게 문제를 생성하지 마세요.

[출력 JSON]

{
  "title": "학습 자료 제목",
  "summary": [
    "핵심 정리"
  ],
  "keyTerms": [
    {
      "term": "용어",
      "meaning": "뜻"
    }
  ],
  "reviewPoints": [
    "복습 내용"
  ],
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
        "보기 1",
        "보기 2",
        "보기 3",
        "보기 4",
        "보기 5"
      ],
      "answer": 0,
      "explanation": "정답 해설",
      "sourceConcept": "참고 개념",
      "difficulty": "보통"
    }
  ]
}

JSON 이외의 글은 출력하지 마세요.
`;

  const response = await callGroq(() =>
    groq.chat.completions.create({
      model: MODEL,

      messages: [
        {
          role: 'system',
          content:
            '당신은 정확한 한국어 교육 전문가입니다. 유효한 JSON만 출력하세요.',
        },

        {
          role: 'user',
          content: prompt,
        },
      ],

      temperature: 0.2,
      max_completion_tokens: 8000,

      response_format: {
        type: 'json_object',
      },
    })
  );

  const raw = getResponseText(response);

  if (!raw) {
    throw new Error(
      'AI가 학습 자료 분석 결과를 반환하지 않았습니다.'
    );
  }

  const data = parseJsonRobust(raw);

  return normalizeStudyData(data);
}

// ==========================================
// 11. 서버 상태 확인
// ==========================================

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(getApiKey()),
    model: MODEL,
    visionModel: VISION_MODEL,

    features: [
      'image-ocr',
      'multi-image-analysis',
      'study-summary',
      'key-terms',
      'review-points',
      'quiz-generation',
      'all-subject-chat',
      'multilingual-chat',
      'level-adaptation',
    ],
  });
});

// ==========================================
// 12. 공부 자료 분석 API
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

      const questionCount = req.body.questionCount || 10;

      if (!typedText && images.length === 0) {
        return res.status(400).json({
          error:
            '공부 내용이나 사진을 등록해 주세요.',
        });
      }

      console.log('==============================');
      console.log('공부 자료 분석 시작');
      console.log('사진 수:', images.length);
      console.log('직접 입력 글자 수:', typedText.length);
      console.log('==============================');

      const groq = getGroqClient();

      // 1. 사진 OCR
      let imageText = '';

      if (images.length > 0) {
        imageText = await extractTextFromImages(
          groq,
          images
        );
      }

      // 2. 직접 입력 내용 + 사진 인식 내용 결합
      const studyMaterial = [
        typedText
          ? `[직접 입력한 학습 내용]\n${typedText}`
          : '',

        imageText
          ? `[사진 OCR 인식 결과]\n${imageText}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, MAX_TEXT_LENGTH);

      if (!studyMaterial.trim()) {
        throw new Error(
          '학습 자료를 인식하지 못했습니다.'
        );
      }

      console.log(
        'OCR 완료. AI 학습 자료 생성 시작:',
        studyMaterial.length,
        '자'
      );

      // 3. AI 요약 및 문제 생성
      const result = await analyzeStudyMaterial(
        groq,
        studyMaterial,
        questionCount
      );

      console.log('공부 자료 분석 완료');

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
// 13. 전 과목 AI 선생님
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
    ).slice(0, 100);

    const language = String(
      req.body.language || '질문 언어에 맞춰 답변'
    ).slice(0, 100);

    const level = String(
      req.body.level || '학생 수준에 맞춰 설명'
    ).slice(0, 100);

    const start = req.body.start === true;

    const incomingMessages = Array.isArray(
      req.body.messages
    )
      ? req.body.messages
      : [];

    const messages = incomingMessages
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

    const lastMessage = messages[messages.length - 1];

    if (
      userMessage &&
      !(
        lastMessage?.role === 'user' &&
        lastMessage.content === userMessage
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

[교육 분야]

국어, 문학, 독서, 문법, 수학, 대수, 기하,
미적분, 확률, 통계, 영어, 과학, 물리학,
화학, 생명과학, 지구과학, 역사, 한국사,
세계사, 사회, 정치, 경제, 지리, 윤리,
철학, 정보, 컴퓨터, 프로그래밍, 인공지능,
음악, 미술, 체육, 기술, 가정 및 일반 교양.

[언어]

한국어, 영어, 중국어, 일본어, 스페인어,
프랑스어, 독일어, 러시아어, 아랍어,
베트남어, 태국어, 이탈리아어, 포르투갈어,
힌디어 및 기타 언어.

[수준]

초등학생: 쉬운 단어와 예시.
중학생: 기초 개념과 원리.
고등학생: 교과 과정과 시험 수준.
대학생: 전공 개념과 전문 용어.
전문가: 심화 설명.

[수학]

공식, 조건, 계산 과정, 정답을 순서대로 설명하세요.
중간 계산을 생략하지 마세요.
수식은 LaTeX를 사용하세요.

[외국어]

번역, 문법, 어휘, 발음, 예문을 설명하세요.

[코딩]

실행 가능한 코드와 오류 원인, 해결 방법을 설명하세요.

[학습 자료]

자료가 있으면 관련 질문에 우선 활용하세요.
자료가 없어도 일반 교육 질문에 답변하세요.
자료에 없는 내용을 자료에서 확인된 것처럼 말하지 마세요.

[대화]

질문에 먼저 답하세요.
어려운 용어는 쉽게 설명하세요.
틀린 정보를 지어내지 마세요.
기본적으로 자연스러운 한국어 존댓말을 사용하세요.
사용자가 요청하면 다른 언어로 답변하세요.

[현재 설정]

과목: ${subject}
답변 언어: ${language}
학습 수준: ${level}

[등록된 공부 자료]

${studyMaterial || '등록된 자료 없음. 일반 교육 질문에 답변하세요.'}
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
      throw new Error('AI 답변을 받지 못했습니다.');
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
// 14. API 경로 오류
// ==========================================

app.use('/api/', (_req, res) => {
  res.status(404).json({
    error: '요청한 API를 찾을 수 없습니다.',
  });
});

// ==========================================
// 15. 전체 오류 처리
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
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      message =
        '이미지 업로드 필드 이름이 올바르지 않습니다.';
    } else {
      message =
        '이미지 업로드 중 오류가 발생했습니다.';
    }

  } else if (status === 401 || status === 403) {
    message =
      'Groq API 키 또는 사용 권한을 확인해 주세요.';

  } else if (status === 404) {
    message =
      'AI 모델을 찾을 수 없습니다. Render 환경 변수의 모델 이름을 확인해 주세요.';

  } else if (status === 413) {
    message =
      '요청 용량이 너무 큽니다. 사진 수나 용량을 줄여 주세요.';

  } else if (status === 429) {
    message =
      'Groq API 사용량 제한입니다. 잠시 기다린 후 다시 시도해 주세요.';

  } else if (status === 400) {
    message =
      `AI 요청 형식 오류: ${error?.message || '요청 내용을 확인해 주세요.'}`;

  } else if (status >= 500 && status !== 503) {
    message =
      'AI 처리 중 서버 오류가 발생했습니다. Render Logs를 확인해 주세요.';
  }

  console.error('==============================');
  console.error('서버 오류 상태:', status);
  console.error('오류 원인:', error?.message || error);
  console.error('==============================');

  return res.status(status).json({
    error: message,
  });
});

// ==========================================
// 16. 서버 실행
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

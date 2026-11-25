
/* =========================================================
   공부킬러 - public/app.js
   전체 수정본

   - 이미지 업로드 및 OCR
   - AI 자료 분석
   - 요약 및 수학 수식
   - 문제 개수 선택 및 퀴즈
   - 전체 문제 채점
   - 오답노트 저장 및 답안 수정
   - 오답만 다시 풀기
   - AI 채팅
   - 학습 기록 저장
========================================================= */

"use strict";

/* =========================================================
   1. 설정 및 상태
========================================================= */

const API = {
  study: "/api/study",
  chat: "/api/chat"
};

const STORAGE = {
  summary: "studyKillerSummary",
  title: "studyKillerTitle",
  questions: "studyKillerQuestions",
  wrong: "studyKillerWrong",
  chat: "studyKillerChat",
  stats: "studyKillerStats",
  sourceText: "studyKillerSourceText"
};

let selectedFile = null;
let currentStudyText = "";
let currentTitle = "";

let allQuestions = [];
let currentQuestions = [];
let currentQuestionIndex = 0;

let userAnswers = [];
let wrongAnswers = [];
let chatHistory = [];

let isLoading = false;
let quizFinished = false;

/* =========================================================
   2. 공통 함수
========================================================= */

const $ = (id) => document.getElementById(id);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function safeJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function showToast(message, type = "info") {
  let toast = $("studyKillerToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "studyKillerToast";

    toast.style.cssText = `
      position:fixed;
      left:50%;
      bottom:24px;
      transform:translateX(-50%);
      z-index:999999;
      padding:13px 20px;
      border-radius:12px;
      background:#25243a;
      color:#fff;
      font-size:14px;
      max-width:90vw;
      box-shadow:0 8px 28px #0003;
    `;

    document.body.appendChild(toast);
  }

  toast.textContent = message;

  toast.style.border =
    type === "error"
      ? "1px solid #ed5364"
      : type === "success"
        ? "1px solid #18a66a"
        : "1px solid transparent";

  clearTimeout(toast._timer);

  toast._timer = setTimeout(() => {
    toast.remove();
  }, 3200);
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === "string") return item;

      if (item && typeof item === "object") {
        if (item.term && item.meaning) {
          return `${item.term}: ${item.meaning}`;
        }

        return (
          item.text ||
          item.content ||
          item.title ||
          JSON.stringify(item)
        );
      }

      return String(item ?? "");
    }).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(/\n+/).filter(Boolean);
  }

  return [];
}

/* =========================================================
   3. 로딩
========================================================= */

function setLoading(state, message = "처리 중입니다...") {
  isLoading = state;

  const loading = $("loading");

  if (loading) {
    loading.style.display = state ? "flex" : "none";

    const label = loading.querySelector(".loading-text");

    if (label) {
      label.textContent = message;
    }
  }

  [
    "uploadButton",
    "chatSend"
  ].forEach(id => {
    const button = $(id);
    if (button) button.disabled = state;
  });

  const quizButton = document.querySelector(
    "#quiz .quiz-settings button"
  );

  if (quizButton) {
    quizButton.disabled = state;
  }
}

/* =========================================================
   4. 서버 응답 처리
========================================================= */

async function readResponse(response) {
  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      "서버 응답을 읽을 수 없습니다. 서버 상태를 확인해 주세요."
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error || `서버 오류 (${response.status})`
    );
  }

  return data;
}

/* =========================================================
   5. 페이지 이동
========================================================= */

function showPage(pageName) {
  const target = $(pageName);

  if (!target || !target.classList.contains("page")) {
    console.warn("페이지를 찾을 수 없습니다:", pageName);
    return;
  }

  document.querySelectorAll("main .page").forEach(page => {
    page.classList.remove("active");
  });

  target.classList.add("active");

  document.querySelectorAll(".nav-button").forEach(button => {
    const action = button.getAttribute("onclick") || "";

    button.classList.toggle(
      "active",
      action.includes(`'${pageName}'`) ||
      action.includes(`"${pageName}"`)
    );
  });

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });

  if (pageName === "wrong") {
    renderWrongAnswers();
  }

  if (pageName === "summary") {
    loadSummaryIntoView();
  }
}

window.showPage = showPage;

/* =========================================================
   6. 수학 수식 및 글자
========================================================= */

function renderMathText(value) {
  const source = String(value ?? "");

  const pattern =
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

  let html = "";
  let last = 0;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    html += escapeHTML(
      source.slice(last, match.index)
    ).replace(/\n/g, "<br>");

    const display = match[1] ?? match[2];
    const inline = match[3] ?? match[4];
    const expression = display ?? inline;

    if (window.katex) {
      try {
        const rendered = window.katex.renderToString(
          expression,
          {
            displayMode: display !== undefined,
            throwOnError: false,
            strict: "ignore",
            trust: false,
            macros: {
              "\\R": "\\mathbb{R}",
              "\\N": "\\mathbb{N}",
              "\\Z": "\\mathbb{Z}",
              "\\Q": "\\mathbb{Q}",
              "\\C": "\\mathbb{C"
            }
          }
        );

        html += display !== undefined
          ? `<div class="math-display">${rendered}</div>`
          : `<span class="math-inline">${rendered}</span>`;

      } catch (error) {
        console.warn("수식 렌더링 오류:", error);
        html += escapeHTML(expression);
      }
    } else {
      html += escapeHTML(expression);
    }

    last = pattern.lastIndex;
  }

  html += escapeHTML(
    source.slice(last)
  ).replace(/\n/g, "<br>");

  return html;
}

function renderRichText(value) {
  return renderMathText(value);
}

function renderAllMath(root = document) {
  if (!window.renderMathInElement) return;

  try {
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false }
      ],
      throwOnError: false,
      ignoredTags: [
        "script",
        "noscript",
        "style",
        "textarea",
        "pre",
        "code"
      ]
    });
  } catch (error) {
    console.warn("KaTeX 오류:", error);
  }
}

window.renderRichText = renderRichText;
window.renderAllMath = renderAllMath;

/* =========================================================
   7. 이미지 선택
========================================================= */

function handleFileSelect(event) {
  const file = event.target.files?.[0] || null;

  selectedFile = null;

  const name = $("fileName");
  const preview = $("imagePreview");

  if (name) name.textContent = "";

  if (preview) {
    preview.removeAttribute("src");
    preview.style.display = "none";
  }

  if (!file) return;

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowedTypes.includes(file.type)) {
    event.target.value = "";

    showToast(
      "JPG, PNG, WEBP 이미지만 업로드할 수 있습니다.",
      "error"
    );
    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    event.target.value = "";

    showToast(
      "이미지는 8MB 이하로 선택해 주세요.",
      "error"
    );
    return;
  }

  selectedFile = file;

  if (name) {
    name.textContent = `선택된 파일: ${file.name}`;
  }

  if (preview) {
    const reader = new FileReader();

    reader.onload = () => {
      preview.src = reader.result;
      preview.style.display = "block";
    };

    reader.onerror = () => {
      showToast("이미지 미리보기에 실패했습니다.", "error");
    };

    reader.readAsDataURL(file);
  }

  showToast("이미지가 선택되었습니다.", "success");
}

window.handleFileSelect = handleFileSelect;

/* =========================================================
   8. OCR
========================================================= */

async function runOCR(file) {
  if (!window.Tesseract) {
    throw new Error(
      "OCR 기능을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."
    );
  }

  const result = await window.Tesseract.recognize(
    file,
    "kor+eng",
    {
      logger(info) {
        if (info.status === "recognizing text") {
          const percent = Math.round(
            (info.progress || 0) * 100
          );

          const label = $("loading")?.querySelector(
            ".loading-text"
          );

          if (label) {
            label.textContent =
              `사진 글자 인식 중... ${percent}%`;
          }
        }
      }
    }
  );

  return String(result?.data?.text || "").trim();
}

/* =========================================================
   9. 문제 데이터 정리
========================================================= */

function normalizeQuestion(q) {
  if (!q || typeof q !== "object") return null;

  const question = String(
    q.question || q.text || ""
  ).trim();

  let options = q.options || q.choices || [];

  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      options = options
        .split(/\n/)
        .map(v => v.replace(/^\s*[①②③④⑤1-5.)]+\s*/, "").trim())
        .filter(Boolean);
    }
  }

  if (!Array.isArray(options)) return null;

  options = options.map(value => String(value));

  let answer = q.answer;

  if (typeof answer === "string") {
    const trimmed = answer.trim();

    if (/^[1-5]$/.test(trimmed)) {
      answer = Number(trimmed) - 1;
    } else {
      const found = options.indexOf(trimmed);
      answer = found >= 0 ? found : Number(answer);
    }
  } else {
    answer = Number(answer);
  }

  if (
    !question ||
    options.length < 2 ||
    !Number.isInteger(answer) ||
    answer < 0 ||
    answer >= options.length
  ) {
    return null;
  }

  return {
    question,
    options,
    answer,
    explanation: String(
      q.explanation ||
      q.solution ||
      "해설이 제공되지 않았습니다."
    ),
    sourceConcept: String(q.sourceConcept || ""),
    difficulty: String(q.difficulty || "보통")
  };
}

/* =========================================================
   10. 자료 분석
========================================================= */

function getRequestedQuestionCount() {
  const input =
    $("questionCount") ||
    $("quizCount") ||
    $("questionCountSelect") ||
    $("quizQuestionCount") ||
    document.querySelector('[name="questionCount"]');

  const count = Number(input?.value || 20);

  return Math.max(
    1,
    Math.min(100, Number.isFinite(count) ? count : 20)
  );
}

async function analyzeStudyMaterial() {
  if (isLoading) return;

  const file =
    selectedFile ||
    $("fileInput")?.files?.[0] ||
    null;

  if (!file) {
    showToast("먼저 공부 자료 이미지를 선택해 주세요.", "error");
    return;
  }

  const title =
    $("fileName")?.textContent.replace(
      /^선택된 파일:\s*/,
      ""
    ) || "나의 공부 자료";

  const requestedCount = getRequestedQuestionCount();

  const button = $("uploadButton");
  const originalLabel = button?.textContent;

  setLoading(true, "공부 자료를 분석하고 있습니다...");

  try {
    const ocrText = await runOCR(file);

    if (ocrText.length < 3) {
      throw new Error(
        "사진에서 글자를 충분히 인식하지 못했습니다. 더 선명한 사진을 사용해 주세요."
      );
    }

    const form = new FormData();

    form.append("title", title);
    form.append("text", ocrText);
    form.append("questionCount", String(requestedCount));
    form.append("images", file);

    const response = await fetch(API.study, {
      method: "POST",
      body: form
    });

    const data = await readResponse(response);

    const summary = normalizeArray(data.summary);

    if (!summary.length) {
      throw new Error("AI 분석 결과에 요약이 없습니다.");
    }

    currentTitle = String(data.title || title);
    currentStudyText = String(
      data.studyMaterial || ocrText
    );

    currentQuestions = (
      Array.isArray(data.questions)
        ? data.questions
        : []
    )
      .map(normalizeQuestion)
      .filter(Boolean);

    allQuestions = [...currentQuestions];

    if (!allQuestions.length) {
      throw new Error(
        "문제를 생성하지 못했습니다. 사진을 다시 등록해 주세요."
      );
    }

    const saved = {
      title: currentTitle,
      summary,
      keyTerms: normalizeArray(data.keyTerms),
      reviewPoints: normalizeArray(data.reviewPoints),
      solutions: Array.isArray(data.solutions)
        ? data.solutions
        : []
    };

    localStorage.setItem(STORAGE.summary, JSON.stringify(saved));
    localStorage.setItem(STORAGE.title, currentTitle);
    localStorage.setItem(STORAGE.questions, JSON.stringify(allQuestions));
    localStorage.setItem(STORAGE.sourceText, currentStudyText);

    incrementDocumentCount();

    displaySummary(saved);

    showPage("summary");

    showToast(
      `분석 완료! ${allQuestions.length}개 문제가 생성되었습니다.`,
      "success"
    );

    if (allQuestions.length < requestedCount) {
      showToast(
        `요청한 ${requestedCount}개보다 적은 ${allQuestions.length}개가 생성되었습니다. 서버 설정도 확인해 주세요.`,
        "error"
      );
    }

  } catch (error) {
    console.error("자료 분석 실패:", error);

    showToast(
      error.message || "자료 분석 중 오류가 발생했습니다.",
      "error"
    );

  } finally {
    setLoading(false);

    if (button && originalLabel) {
      button.textContent = originalLabel;
    }
  }
}

window.analyzeStudyMaterial = analyzeStudyMaterial;

/* =========================================================
   11. 요약 화면
========================================================= */

function displaySummary(data) {
  const container = $("summaryContent");
  if (!container || !data) return;

  const summary = normalizeArray(data.summary);
  const terms = normalizeArray(data.keyTerms);
  const points = normalizeArray(data.reviewPoints);

  const sections = [];

  if (data.title) {
    sections.push(`<h2>${escapeHTML(data.title)}</h2>`);
  }

  sections.push("<h3>핵심 요약</h3>");
  sections.push(
    summary.length
      ? `<ul>${summary.map(item =>
          `<li>${renderRichText(item)}</li>`
        ).join("")}</ul>`
      : "<p>요약 내용이 없습니다.</p>"
  );

  sections.push("<h3>중요 용어</h3>");
  sections.push(
    terms.length
      ? `<ul>${terms.map(item =>
          `<li>${renderRichText(item)}</li>`
        ).join("")}</ul>`
      : "<p>중요 용어가 없습니다.</p>"
  );

  sections.push("<h3>시험 대비 포인트</h3>");
  sections.push(
    points.length
      ? `<ul>${points.map(item =>
          `<li>${renderRichText(item)}</li>`
        ).join("")}</ul>`
      : "<p>복습 포인트가 없습니다.</p>"
  );

  container.innerHTML = sections.join("");
  renderAllMath(container);
}

window.displaySummary = displaySummary;

function loadSummaryIntoView() {
  const raw = localStorage.getItem(STORAGE.summary);
  if (!raw) return;

  const data = safeJSON(raw, null);
  if (data) displaySummary(data);
}

/* =========================================================
   12. 문제 개수 선택 및 퀴즈 시작
========================================================= */

function generateQuiz(count) {
  const requestedCount = Math.max(
    1,
    Math.min(
      100,
      Number(count || getRequestedQuestionCount()) || 20
    )
  );

  allQuestions = safeJSON(
    localStorage.getItem(STORAGE.questions) || "[]",
    []
  )
    .map(normalizeQuestion)
    .filter(Boolean);

  if (!allQuestions.length) {
    showToast(
      "먼저 공부 자료를 분석해 주세요.",
      "error"
    );
    return;
  }

  if (allQuestions.length < requestedCount) {
    showToast(
      `현재 생성된 문제는 ${allQuestions.length}개입니다. ${requestedCount}개를 풀려면 서버에서 문제를 더 생성해야 합니다.`,
      "error"
    );

    // 있는 문제만 풀 수 있도록 선택
    currentQuestions = [...allQuestions];
  } else {
    currentQuestions = allQuestions.slice(0, requestedCount);
  }

  currentQuestionIndex = 0;
  userAnswers = new Array(currentQuestions.length).fill(null);
  quizFinished = false;

  const area = $("quizArea");
  if (area) area.style.display = "block";

  showPage("quiz");
  displayQuizQuestion();

  showToast(
    `${currentQuestions.length}문제 출제를 시작합니다.`,
    "success"
  );
}

window.generateQuiz = generateQuiz;

/* =========================================================
   13. 문제 표시
========================================================= */

function displayQuizQuestion() {
  const q = currentQuestions[currentQuestionIndex];
  if (!q) return;

  const number = $("questionNumber");
  const progress = $("quizProgress");
  const question = $("quizQuestion");
  const options = $("quizOptions");

  if (number) {
    number.textContent =
      `문제 ${currentQuestionIndex + 1} / ${currentQuestions.length}`;
  }

  if (progress) {
    progress.style.width =
      `${((currentQuestionIndex + 1) / currentQuestions.length) * 100}%`;
  }

  if (question) {
    question.innerHTML = renderRichText(q.question);
  }

  if (options) {
    options.innerHTML = q.options.map((option, index) => {
      const selected = userAnswers[currentQuestionIndex] === index;

      return `
        <button
          type="button"
          class="quiz-option ${selected ? "selected" : ""}"
          data-answer="${index}"
          ${userAnswers[currentQuestionIndex] !== null ? "disabled" : ""}
        >
          <span class="option-number">${index + 1}</span>
          <span class="option-text">${renderRichText(option)}</span>
        </button>
      `;
    }).join("");

    options.querySelectorAll("[data-answer]").forEach(button => {
      button.addEventListener("click", () => {
        chooseAnswer(Number(button.dataset.answer));
      });
    });
  }

  let feedback = $("quizFeedback");

  if (!feedback) {
    feedback = document.createElement("div");
    feedback.id = "quizFeedback";

    feedback.style.cssText = `
      margin-top:18px;
      padding:14px;
      border-radius:12px;
      background:#f3f1ff;
      line-height:1.8;
      display:none;
    `;

    $("quizArea")?.appendChild(feedback);
  }

  if (userAnswers[currentQuestionIndex] === null) {
    feedback.style.display = "none";
  } else {
    showQuizFeedback();
  }

  renderAllMath($("quizArea"));
}

/* =========================================================
   14. 답 선택
========================================================= */

function chooseAnswer(index) {
  if (quizFinished) return;

  if (userAnswers[currentQuestionIndex] !== null) return;

  const q = currentQuestions[currentQuestionIndex];

  if (!q || index < 0 || index >= q.options.length) return;

  userAnswers[currentQuestionIndex] = index;

  $("quizOptions")
    ?.querySelectorAll("[data-answer]")
    .forEach(button => {
      const choice = Number(button.dataset.answer);

      button.disabled = true;

      if (choice === q.answer) {
        button.classList.add("correct");
      }

      if (choice === index && index !== q.answer) {
        button.classList.add("incorrect");
      }

      if (choice === index) {
        button.classList.add("selected");
      }
    });

  showQuizFeedback();
}

window.chooseAnswer = chooseAnswer;

/* =========================================================
   15. 정답 해설
========================================================= */

function showQuizFeedback() {
  const q = currentQuestions[currentQuestionIndex];
  const selected = userAnswers[currentQuestionIndex];
  const feedback = $("quizFeedback");

  if (!q || selected === null || !feedback) return;

  const correct = selected === q.answer;

  feedback.style.display = "block";

  feedback.innerHTML = `
    <strong style="color:${correct ? "#18a66a" : "#ed5364"}">
      ${correct ? "정답입니다!" : "틀렸습니다."}
    </strong>
    <br>
    <b>정답:</b>
    ${renderRichText(q.options[q.answer])}
    <br>
    <b>해설:</b>
    ${renderRichText(q.explanation)}
  `;

  renderAllMath(feedback);
}

/* =========================================================
   16. 이전 / 다음 문제
========================================================= */

function nextQuestion() {
  if (!currentQuestions.length) return;

  if (userAnswers[currentQuestionIndex] === null) {
    showToast("먼저 답을 선택해 주세요.", "error");
    return;
  }

  if (currentQuestionIndex < currentQuestions.length - 1) {
    currentQuestionIndex++;
    displayQuizQuestion();
  } else {
    finishQuiz();
  }
}

function previousQuestion() {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    displayQuizQuestion();
  } else {
    showToast("첫 번째 문제입니다.");
  }
}

window.nextQuestion = nextQuestion;
window.previousQuestion = previousQuestion;

/* =========================================================
   17. 시험 결과 및 오답 저장
========================================================= */

function finishQuiz() {
  if (quizFinished) return;

  const unanswered = userAnswers.filter(
    answer => answer === null
  ).length;

  if (unanswered > 0) {
    showToast(
      `아직 풀지 않은 문제가 ${unanswered}개 있습니다.`,
      "error"
    );
    return;
  }

  quizFinished = true;

  let correctCount = 0;
  const newWrongAnswers = [];

  currentQuestions.forEach((q, index) => {
    const selected = userAnswers[index];

    if (selected === q.answer) {
      correctCount++;
    } else {
      newWrongAnswers.push({
        question: q.question,
        options: [...q.options],
        answer: q.answer,
        selected,
        explanation: q.explanation,
        sourceConcept: q.sourceConcept,
        difficulty: q.difficulty,
        corrected: false
      });
    }
  });

  wrongAnswers = newWrongAnswers;

  localStorage.setItem(
    STORAGE.wrong,
    JSON.stringify(wrongAnswers)
  );

  const total = currentQuestions.length;
  const score = total
    ? Math.round(correctCount / total * 100)
    : 0;

  const result = $("resultContent");

  if (result) {
    result.innerHTML = `
      <div class="result-card">
        <h3>학습 결과</h3>
        <div class="result-score">${score}점</div>
        <p>
          총 ${total}문제 중
          정답 ${correctCount}개 · 오답 ${total - correctCount}개
        </p>
        <p>
          ${
            score >= 90
              ? "훌륭합니다! 거의 완벽합니다."
              : score >= 70
                ? "잘하셨습니다! 조금만 더 복습해 보세요."
                : "틀린 문제를 다시 복습해 보세요."
          }
        </p>
        <p>오답 ${newWrongAnswers.length}개가 오답노트에 저장되었습니다.</p>
        <button type="button" onclick="showWrongAnswers()">
          오답노트 확인하기
        </button>
      </div>
    `;
  }

  updateStudyStats(total, correctCount);

  renderWrongAnswers();
  showPage("quizResult");

  showToast("채점이 완료되었습니다.", "success");
}

window.finishQuiz = finishQuiz;

/* =========================================================
   18. 오답노트 화면
========================================================= */

function renderWrongAnswers() {
  const container = $("wrongList");
  if (!container) return;

  wrongAnswers = safeJSON(
    localStorage.getItem(STORAGE.wrong) || "[]",
    []
  );

  if (!wrongAnswers.length) {
    container.innerHTML = `
      <div class="card">
        <h3>오답이 없습니다!</h3>
        <p>문제를 풀면 틀린 문제가 여기에 저장됩니다.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = wrongAnswers.map((item, index) => {
    const options = Array.isArray(item.options)
      ? item.options
      : [];

    const selected = Number.isInteger(item.selected)
      ? item.selected
      : -1;

    const answer = Number(item.answer);

    return `
      <article class="wrong-card" style="
        padding:20px;
        margin-bottom:18px;
        border:1px solid #e5e7eb;
        border-radius:16px;
        background:white;
      ">
        <h3>오답 ${index + 1}</h3>

        <div class="wrong-question">
          ${renderRichText(item.question)}
        </div>

        <p style="color:#e05260;margin-top:12px;">
          내 답:
          ${renderRichText(options[selected] || "미응답")}
        </p>

        <p style="color:#18a66a;">
          정답:
          ${renderRichText(options[answer] || "정답 정보 없음")}
        </p>

        <div style="margin:15px 0;">
          <b>답안 수정 및 다시 채점</b>

          <div style="display:grid;gap:8px;margin-top:10px;">
            ${options.map((option, optionIndex) => `
              <label style="
                display:flex;
                gap:10px;
                align-items:center;
                padding:12px;
                border:1px solid #ddd;
                border-radius:10px;
                cursor:pointer;
              ">
                <input
                  type="radio"
                  name="wrong-answer-${index}"
                  value="${optionIndex}"
                  ${selected === optionIndex ? "checked" : ""}
                >
                <span>${renderRichText(option)}</span>
              </label>
            `).join("")}
          </div>
        </div>

        <div class="wrong-explanation" style="
          padding:12px;
          background:#f5f5fa;
          border-radius:10px;
          margin-top:12px;
        ">
          <b>해설</b>
          <p>${renderRichText(item.explanation)}</p>
        </div>

        <button
          type="button"
          onclick="saveWrongAnswerEdit(${index})"
          style="
            width:100%;
            margin-top:14px;
            padding:12px;
            border:0;
            border-radius:10px;
            background:#6657e8;
            color:white;
            cursor:pointer;
          "
        >
          답안 수정 및 다시 채점
        </button>
      </article>
    `;
  }).join("");

  renderAllMath(container);
}

window.renderWrongAnswers = renderWrongAnswers;

/* =========================================================
   19. 오답 수정 및 재채점
========================================================= */

function saveWrongAnswerEdit(index) {
  wrongAnswers = safeJSON(
    localStorage.getItem(STORAGE.wrong) || "[]",
    []
  );

  const item = wrongAnswers[index];

  if (!item) {
    showToast("문제를 찾을 수 없습니다.", "error");
    return;
  }

  const selectedInput = document.querySelector(
    `input[name="wrong-answer-${index}"]:checked`
  );

  if (!selectedInput) {
    showToast("수정할 답을 선택해 주세요.", "error");
    return;
  }

  const selected = Number(selectedInput.value);
  const correct = selected === Number(item.answer);

  if (correct) {
    wrongAnswers.splice(index, 1);

    showToast(
      "정답입니다! 오답노트에서 제거했습니다.",
      "success"
    );
  } else {
    item.selected = selected;
    item.corrected = false;
    item.lastAttemptAt = new Date().toISOString();

    showToast(
      "아직 틀렸습니다. 해설을 다시 확인해 주세요.",
      "error"
    );
  }

  localStorage.setItem(
    STORAGE.wrong,
    JSON.stringify(wrongAnswers)
  );

  renderWrongAnswers();
}

window.saveWrongAnswerEdit = saveWrongAnswerEdit;

/* =========================================================
   20. 오답만 다시 풀기
========================================================= */

function retryWrongAnswers() {
  wrongAnswers = safeJSON(
    localStorage.getItem(STORAGE.wrong) || "[]",
    []
  );

  if (!wrongAnswers.length) {
    showToast("다시 풀 오답이 없습니다.", "info");
    return;
  }

  currentQuestions = wrongAnswers.map(item => ({
    question: item.question,
    options: [...item.options],
    answer: Number(item.answer),
    explanation: item.explanation
  }));

  currentQuestionIndex = 0;
  userAnswers = new Array(currentQuestions.length).fill(null);
  quizFinished = false;

  if ($("quizArea")) {
    $("quizArea").style.display = "block";
  }

  showPage("quiz");
  displayQuizQuestion();

  showToast(
    `${currentQuestions.length}개의 오답을 다시 풉니다.`,
    "success"
  );
}

window.retryWrongAnswers = retryWrongAnswers;

window.showWrongAnswers = function() {
  renderWrongAnswers();
  showPage("wrong");
};

/* =========================================================
   21. AI 채팅
========================================================= */

async function sendChat(message) {
  if (isLoading) return;

  const input = $("chatInput");

  const text = String(
    message ?? input?.value ?? ""
  ).trim();

  if (!text) {
    showToast("질문을 입력해 주세요.", "error");
    return;
  }

  const studyMaterial =
    currentStudyText || getSavedStudyText();

  if (!studyMaterial) {
    showToast(
      "먼저 공부 자료를 등록해 주세요.",
      "error"
    );
    return;
  }

  if (input) input.value = "";

  addChatMessage(text, "user");

  setLoading(true, "AI가 답변을 작성하고 있습니다...");

  try {
    const response = await fetch(API.chat, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        studyMaterial,
        message: text,
        messages: chatHistory
      })
    });

    const data = await readResponse(response);

    const reply = String(
      data.reply || data.answer || data.message || ""
    ).trim();

    if (!reply) {
      throw new Error("AI 답변이 비어 있습니다.");
    }

    addChatMessage(reply, "assistant");

    chatHistory.push(
      { role: "user", content: text },
      { role: "assistant", content: reply }
    );

    chatHistory = chatHistory.slice(-24);

    localStorage.setItem(
      STORAGE.chat,
      JSON.stringify(chatHistory)
    );

  } catch (error) {
    console.error("채팅 오류:", error);

    addChatMessage(
      `답변을 가져오지 못했습니다.\n${error.message}`,
      "assistant"
    );

  } finally {
    setLoading(false);
  }
}

function requestAIChat(message) {
  return sendChat(message);
}

function sendChatMessage() {
  return sendChat();
}

window.requestAIChat = requestAIChat;
window.sendChatMessage = sendChatMessage;

/* =========================================================
   22. 채팅 메시지 표시
========================================================= */

function addChatMessage(message, role = "assistant") {
  const container = $("chatMessages");
  if (!container) return;

  const item = document.createElement("div");

  item.className =
    `chat-message ${role === "user" ? "user" : "assistant"}`;

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = renderRichText(message);

  item.appendChild(content);
  container.appendChild(item);

  renderAllMath(item);
  container.scrollTop = container.scrollHeight;
}

function loadChatHistory() {
  chatHistory = safeJSON(
    localStorage.getItem(STORAGE.chat) || "[]",
    []
  );

  const container = $("chatMessages");

  if (!container || !chatHistory.length) return;

  container.innerHTML = "";

  chatHistory.forEach(item => {
    if (
      item &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string"
    ) {
      addChatMessage(item.content, item.role);
    }
  });
}

/* =========================================================
   23. 저장된 공부 자료
========================================================= */

function getSavedStudyText() {
  const rawText = localStorage.getItem(STORAGE.sourceText);

  if (rawText) return rawText;

  const data = safeJSON(
    localStorage.getItem(STORAGE.summary) || "{}",
    {}
  );

  return [
    ...normalizeArray(data.summary),
    ...normalizeArray(data.keyTerms),
    ...normalizeArray(data.reviewPoints)
  ].join("\n");
}

/* =========================================================
   24. 학습 통계
========================================================= */

function getStats() {
  return safeJSON(
    localStorage.getItem(STORAGE.stats) || "{}",
    {}
  );
}

function saveStats(stats) {
  localStorage.setItem(
    STORAGE.stats,
    JSON.stringify(stats)
  );
}

function incrementDocumentCount() {
  const stats = getStats();

  stats.documents = Number(stats.documents || 0) + 1;

  saveStats(stats);
}

function updateStudyStats(solved, correct) {
  const stats = getStats();

  stats.solved = Number(stats.solved || 0) + solved;
  stats.correct = Number(stats.correct || 0) + correct;

  saveStats(stats);
}

/* =========================================================
   25. 앱 초기화
========================================================= */

function initializeApp() {
  console.log("공부킬러 초기화 시작");

  const fileInput = $("fileInput");

  if (fileInput) {
    fileInput.addEventListener(
      "change",
      handleFileSelect
    );
  }

  const uploadButton = $("uploadButton");

  if (uploadButton) {
    uploadButton.addEventListener(
      "click",
      analyzeStudyMaterial
    );
  }

  const chatButton = $("chatSend");

  if (chatButton) {
    chatButton.addEventListener(
      "click",
      () => sendChat()
    );
  }

  const chatInput = $("chatInput");

  if (chatInput) {
    chatInput.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChat();
      }
    });
  }

  loadSummaryIntoView();

  allQuestions = safeJSON(
    localStorage.getItem(STORAGE.questions) || "[]",
    []
  )
    .map(normalizeQuestion)
    .filter(Boolean);

  currentQuestions = [...allQuestions];

  currentTitle =
    localStorage.getItem(STORAGE.title) || "";

  currentStudyText = getSavedStudyText();

  wrongAnswers = safeJSON(
    localStorage.getItem(STORAGE.wrong) || "[]",
    []
  );

  loadChatHistory();
  renderWrongAnswers();
  renderAllMath(document);

  const loading = $("loading");

  if (loading) {
    loading.style.display = "none";
  }

  console.log(
    "공부킬러 초기화 완료",
    {
      questions: allQuestions.length,
      wrongAnswers: wrongAnswers.length
    }
  );
}

/* =========================================================
   26. 전역 함수 연결
========================================================= */

window.showPage = showPage;
window.handleFileSelect = handleFileSelect;
window.analyzeStudyMaterial = analyzeStudyMaterial;

window.generateQuiz = generateQuiz;
window.chooseAnswer = chooseAnswer;
window.nextQuestion = nextQuestion;
window.previousQuestion = previousQuestion;
window.finishQuiz = finishQuiz;

window.showWrongAnswers = window.showWrongAnswers;
window.renderWrongAnswers = renderWrongAnswers;
window.retryWrongAnswers = retryWrongAnswers;
window.saveWrongAnswerEdit = saveWrongAnswerEdit;

window.requestAIChat = requestAIChat;
window.sendChatMessage = sendChatMessage;

window.displaySummary = displaySummary;
window.renderRichText = renderRichText;
window.renderAllMath = renderAllMath;

/* =========================================================
   27. 실행
========================================================= */

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeApp
  );
} else {
  initializeApp();
}


/* =========================================================
   공부킬러 - public/app.js
   전체 수정 및 복구 버전

   1. 페이지 이동
   2. 이미지 선택 및 미리보기
   3. Tesseract OCR
   4. AI 자료 분석
   5. 핵심 요약 및 수학 수식
   6. 문제 생성 및 채점
   7. 시험 결과
   8. 오답노트 자동 저장 및 이동
   9. 오답 다시 풀기
   10. AI 채팅
   11. 학습 기록 저장
========================================================= */

"use strict";

/* =========================================================
   1. 설정
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

function safeStorageGet(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (error) {
    console.warn("저장 데이터 읽기 실패:", error);
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.error("저장 실패:", error);
    showToast("저장 공간이 부족하거나 브라우저 저장이 차단되었습니다.", "error");
    return false;
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
      bottom:22px;
      transform:translateX(-50%);
      z-index:10000;
      padding:13px 20px;
      border-radius:12px;
      background:#25243a;
      color:white;
      font-size:13px;
      max-width:90vw;
      box-shadow:0 8px 28px #0002;
      transition:.2s;
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

/* =========================================================
   3. 로딩
========================================================= */

function setLoading(state, message = "처리 중입니다...") {
  isLoading = state;

  const loading = $("loading");

  if (loading) {
    loading.style.display = state ? "flex" : "none";

    const text = loading.querySelector(".loading-text");

    if (text) {
      text.textContent = message;
    }
  }

  ["uploadButton", "chatSend"].forEach(id => {
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
   4. 서버 응답
========================================================= */

async function readResponse(response) {
  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      "서버 응답을 읽을 수 없습니다. 서버 실행 상태를 확인해 주세요."
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
    showToast("페이지를 찾을 수 없습니다: " + pageName, "error");
    return false;
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

  return true;
}

window.showPage = showPage;

/* =========================================================
   6. 수학 수식
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
              "\\C": "\\mathbb{C}"
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
      "JPG, PNG, WEBP 이미지 파일만 선택할 수 있습니다.",
      "error"
    );

    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    event.target.value = "";

    showToast(
      "이미지는 8MB 이하의 파일을 선택해 주세요.",
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
      showToast("이미지 미리보기를 불러오지 못했습니다.", "error");
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

          const label = $("loading")?.querySelector(".loading-text");

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
   9. 배열 데이터 정리
========================================================= */

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
   10. 자료 분석
========================================================= */

async function analyzeStudyMaterial() {
  if (isLoading) return;

  const file =
    selectedFile ||
    $("fileInput")?.files?.[0] ||
    null;

  const title =
    $("fileName")?.textContent.replace(
      /^선택된 파일:\s*/,
      ""
    ) || "나의 공부 자료";

  if (!file) {
    showToast("먼저 공부 자료 이미지를 선택해 주세요.", "error");
    return;
  }

  const button = $("uploadButton");
  const originalLabel = button?.textContent;

  setLoading(true, "공부 자료를 준비하고 있습니다...");

  try {
    const ocrText = await runOCR(file);

    if (ocrText.length < 3) {
      throw new Error(
        "사진에서 글자를 충분히 인식하지 못했습니다. 더 선명한 사진으로 다시 시도해 주세요."
      );
    }

    const form = new FormData();

    form.append("title", title);
    form.append("text", ocrText);
    form.append("images", file);

    const response = await fetch(API.study, {
      method: "POST",
      body: form
    });

    const data = await readResponse(response);

    if (
      !data.summary ||
      (Array.isArray(data.summary) && !data.summary.length)
    ) {
      throw new Error("AI 분석 결과가 비어 있습니다.");
    }

    currentTitle = String(data.title || title);
    currentStudyText = String(
      data.studyMaterial || ocrText
    );

    currentQuestions = (
      Array.isArray(data.questions) ? data.questions : []
    )
      .map(normalizeQuestion)
      .filter(Boolean);

    if (!currentQuestions.length) {
      throw new Error(
        "문제를 생성하지 못했습니다. 자료를 다시 등록해 주세요."
      );
    }

    const saved = {
      title: currentTitle,
      summary: normalizeArray(data.summary),
      keyTerms: normalizeArray(data.keyTerms),
      reviewPoints: normalizeArray(data.reviewPoints)
    };

    safeStorageSet(STORAGE.summary, JSON.stringify(saved));
    safeStorageSet(STORAGE.title, currentTitle);
    safeStorageSet(STORAGE.questions, JSON.stringify(currentQuestions));
    safeStorageSet(STORAGE.sourceText, currentStudyText);

    incrementDocumentCount();

    displaySummary(saved);
    showPage("summary");

    showToast(
      `분석 완료! AI가 ${currentQuestions.length}개 문제를 만들었습니다.`,
      "success"
    );

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
  try {
    const raw = safeStorageGet(STORAGE.summary);

    if (!raw) return;

    displaySummary(JSON.parse(raw));
  } catch (error) {
    console.warn("요약 불러오기 실패:", error);
  }
}

/* =========================================================
   12. 문제 정규화
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
      options = options.split(/\n/).filter(Boolean);
    }
  }

  if (!Array.isArray(options)) options = [];

  options = options.map(option => String(option));

  const answer = Number(
    q.answer ??
    q.correctAnswer ??
    q.correct_answer ??
    0
  );

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
    )
  };
}

/* =========================================================
   13. 퀴즈 시작
========================================================= */

function generateQuiz(count = 10) {
  try {
    if (!currentQuestions.length) {
      currentQuestions = JSON.parse(
        safeStorageGet(STORAGE.questions, "[]")
      )
        .map(normalizeQuestion)
        .filter(Boolean);
    }
  } catch {
    currentQuestions = [];
  }

  if (!currentQuestions.length) {
    showToast(
      "먼저 자료 업로드 메뉴에서 공부 자료를 분석해 주세요.",
      "error"
    );
    return;
  }

  const requestedCount = Math.max(
    1,
    Math.min(100, Number(count) || 10)
  );

  if (currentQuestions.length < requestedCount) {
    showToast(
      `현재 생성된 문제는 ${currentQuestions.length}개입니다. 생성된 문제를 출제합니다.`,
      "info"
    );
  }

  currentQuestionIndex = 0;
  userAnswers = new Array(currentQuestions.length).fill(null);
  wrongAnswers = [];
  quizFinished = false;

  const area = $("quizArea");

  if (area) area.style.display = "block";

  showPage("quiz");
  displayQuizQuestion();
}

window.generateQuiz = generateQuiz;

/* =========================================================
   14. 문제 표시
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

  feedback.style.display =
    userAnswers[currentQuestionIndex] === null ? "none" : "block";

  if (userAnswers[currentQuestionIndex] !== null) {
    showQuizFeedback();
  }

  renderAllMath($("quizArea"));
}

/* =========================================================
   15. 정답 선택
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
   16. 정답 해설
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
   17. 다음 문제
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

window.nextQuestion = nextQuestion;

/* =========================================================
   18. 이전 문제
========================================================= */

function previousQuestion() {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    displayQuizQuestion();
  } else {
    showToast("첫 번째 문제입니다.");
  }
}

window.previousQuestion = previousQuestion;

/* =========================================================
   19. 시험 결과
========================================================= */

function finishQuiz() {
  if (quizFinished) return;

  if (userAnswers.some(answer => answer === null)) {
    showToast("아직 풀지 않은 문제가 있습니다.", "error");
    return;
  }

  quizFinished = true;

  let correct = 0;
  wrongAnswers = [];

  currentQuestions.forEach((q, index) => {
    const selected = userAnswers[index];

    if (selected === q.answer) {
      correct++;
    } else {
      wrongAnswers.push({
        question: q.question,
        options: q.options,
        answer: q.answer,
        selected,
        explanation: q.explanation
      });
    }
  });

  // 오답노트 저장
  safeStorageSet(
    STORAGE.wrong,
    JSON.stringify(wrongAnswers)
  );

  const total = currentQuestions.length;

  const score = total
    ? Math.round(correct / total * 100)
    : 0;

  const result = $("resultContent");

  if (result) {
    result.innerHTML = `
      <div class="result-card">
        <h3>학습 결과</h3>

        <div class="result-score">
          ${score}점
        </div>

        <p>
          총 ${total}문제 중
          정답 ${correct}개 · 오답 ${total - correct}개
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

        <button
          type="button"
          class="primary-button"
          onclick="showWrongAnswers()"
        >
          오답 확인하기
        </button>

        <button
          type="button"
          class="secondary-button"
          onclick="generateQuiz()"
        >
          다시 풀기
        </button>
      </div>
    `;
  }

  updateStudyStats(total, correct);

  renderWrongAnswers();

  showPage("quizResult");

  showToast("문제 풀이가 완료되었습니다.", "success");
}

window.finishQuiz = finishQuiz;

/* =========================================================
   20. 오답노트 렌더링
========================================================= */

function renderWrongAnswers() {
  const container = $("wrongList");

  if (!container) {
    console.warn(
      "오답노트 영역 wrongList를 찾을 수 없습니다."
    );
    return;
  }

  try {
    const saved = JSON.parse(
      safeStorageGet(STORAGE.wrong, "[]")
    );

    wrongAnswers = Array.isArray(saved) ? saved : [];

  } catch (error) {
    console.error("오답노트 불러오기 실패:", error);
    wrongAnswers = [];
  }

  if (!wrongAnswers.length) {
    container.innerHTML = `
      <div class="card">
        <p>아직 저장된 오답이 없습니다.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = wrongAnswers.map((item, index) => {
    const options = Array.isArray(item.options)
      ? item.options
      : [];

    const selected =
      item.selected == null
        ? "미응답"
        : options[item.selected] || "미응답";

    const correct =
      options[item.answer] || "정답 정보 없음";

    return `
      <article class="wrong-card">

        <h3>문제 ${index + 1}</h3>

        <div class="wrong-question">
          ${renderRichText(item.question)}
        </div>

        <p class="wrong-selected">
          내 답: ${renderRichText(selected)}
        </p>

        <p class="wrong-correct">
          정답: ${renderRichText(correct)}
        </p>

        <div class="wrong-explanation">
          <b>해설</b><br>
          ${renderRichText(item.explanation)}
        </div>

      </article>
    `;
  }).join("");

  renderAllMath(container);
}

/* =========================================================
   21. 오답노트 이동
========================================================= */

function showWrongAnswers() {
  renderWrongAnswers();

  const moved = showPage("wrong");

  if (moved) {
    showToast(
      wrongAnswers.length
        ? `${wrongAnswers.length}개의 오답을 불러왔습니다.`
        : "아직 저장된 오답이 없습니다.",
      "success"
    );
  }
}

window.showWrongAnswers = showWrongAnswers;
window.renderWrongAnswers = renderWrongAnswers;

/* =========================================================
   22. 오답 다시 풀기
========================================================= */

function retryWrongAnswers() {
  renderWrongAnswers();

  if (!wrongAnswers.length) {
    showToast("다시 풀 오답이 없습니다.", "info");
    return;
  }

  currentQuestions = wrongAnswers.map(item => ({
    question: String(item.question || ""),
    options: Array.isArray(item.options)
      ? item.options.map(String)
      : [],
    answer: Number(item.answer),
    explanation: String(item.explanation || "")
  })).filter(q =>
    q.question &&
    q.options.length >= 2 &&
    Number.isInteger(q.answer) &&
    q.answer >= 0 &&
    q.answer < q.options.length
  );

  if (!currentQuestions.length) {
    showToast("오답 데이터를 불러오지 못했습니다.", "error");
    return;
  }

  currentQuestionIndex = 0;
  userAnswers = new Array(currentQuestions.length).fill(null);
  quizFinished = false;

  const result = $("resultContent");

  if (result) result.innerHTML = "";

  const area = $("quizArea");

  if (area) area.style.display = "block";

  showPage("quiz");
  displayQuizQuestion();
}

window.retryWrongAnswers = retryWrongAnswers;

/* =========================================================
   23. AI 채팅
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

  if (!studyMaterial.trim()) {
    showToast("먼저 공부 자료를 등록해 주세요.", "error");
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
      data.reply ||
      data.answer ||
      data.message ||
      ""
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

    safeStorageSet(
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
   24. 채팅 메시지 출력
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
  try {
    const saved = JSON.parse(
      safeStorageGet(STORAGE.chat, "[]")
    );

    chatHistory = Array.isArray(saved) ? saved : [];

  } catch {
    chatHistory = [];
  }

  const container = $("chatMessages");

  if (!container || !chatHistory.length) return;

  container.innerHTML = "";

  chatHistory.forEach(item => {
    if (
      item &&
      typeof item.content === "string" &&
      ["user", "assistant"].includes(item.role)
    ) {
      addChatMessage(item.content, item.role);
    }
  });
}

/* =========================================================
   25. 저장된 학습 자료
========================================================= */

function getSavedStudyText() {
  const rawText = safeStorageGet(STORAGE.sourceText);

  if (rawText) return rawText;

  try {
    const data = JSON.parse(
      safeStorageGet(STORAGE.summary, "{}")
    );

    return [
      ...normalizeArray(data.summary),
      ...normalizeArray(data.keyTerms),
      ...normalizeArray(data.reviewPoints)
    ].join("\n");

  } catch {
    return "";
  }
}

/* =========================================================
   26. 통계
========================================================= */

function getStats() {
  try {
    const stats = JSON.parse(
      safeStorageGet(STORAGE.stats, "{}")
    );

    return stats && typeof stats === "object" ? stats : {};

  } catch {
    return {};
  }
}

function saveStats(stats) {
  safeStorageSet(STORAGE.stats, JSON.stringify(stats));
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
   27. 초기화
========================================================= */

function initializeApp() {
  console.log("공부킬러 초기화 시작");

  const fileInput = $("fileInput");

  if (fileInput) {
    fileInput.addEventListener("change", handleFileSelect);
  }

  const uploadButton = $("uploadButton");

  if (uploadButton) {
    uploadButton.addEventListener("click", analyzeStudyMaterial);
  }

  const chatButton = $("chatSend");

  if (chatButton) {
    chatButton.addEventListener("click", () => sendChat());
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

  try {
    currentQuestions = JSON.parse(
      safeStorageGet(STORAGE.questions, "[]")
    )
      .map(normalizeQuestion)
      .filter(Boolean);
  } catch {
    currentQuestions = [];
  }

  currentTitle = safeStorageGet(STORAGE.title, "");
  currentStudyText = getSavedStudyText();

  try {
    const savedWrong = JSON.parse(
      safeStorageGet(STORAGE.wrong, "[]")
    );

    wrongAnswers = Array.isArray(savedWrong)
      ? savedWrong
      : [];
  } catch {
    wrongAnswers = [];
  }

  loadChatHistory();
  renderWrongAnswers();
  renderAllMath(document);

  const loading = $("loading");

  if (loading) {
    loading.style.display = "none";
  }

  console.log("공부킬러 초기화 완료");
}

/* =========================================================
   28. 전역 함수 연결
========================================================= */

window.showPage = showPage;
window.handleFileSelect = handleFileSelect;
window.analyzeStudyMaterial = analyzeStudyMaterial;

window.generateQuiz = generateQuiz;
window.chooseAnswer = chooseAnswer;
window.nextQuestion = nextQuestion;
window.previousQuestion = previousQuestion;
window.finishQuiz = finishQuiz;

window.showWrongAnswers = showWrongAnswers;
window.renderWrongAnswers = renderWrongAnswers;
window.retryWrongAnswers = retryWrongAnswers;

window.requestAIChat = requestAIChat;
window.sendChatMessage = sendChatMessage;

window.displaySummary = displaySummary;
window.renderRichText = renderRichText;
window.renderAllMath = renderAllMath;

/* =========================================================
   29. 실행
========================================================= */

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeApp,
    { once: true }
  );
} else {
  initializeApp();
}

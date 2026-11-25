
/* =========================================================
   공부킬러 - public/app.js
   자료 인식 / AI 요약 / 선택 문제 수 생성 / 퀴즈 / 오답 / 채팅
========================================================= */

(() => {
  'use strict';

  const API = {
    study: '/api/study',
    chat: '/api/chat'
  };

  const STORAGE = {
    summary: 'studyKillerSummary',
    title: 'studyKillerTitle',
    questions: 'studyKillerQuestions',
    wrong: 'studyKillerWrong',
    chat: 'studyKillerChat',
    source: 'studyKillerSourceText'
  };

  const state = {
    files: [],
    result: null,
    questions: [],
    quizQuestions: [],
    wrongQuestions: [],
    currentIndex: 0,
    correctCount: 0,
    answers: [],
    selectedCount: 20,
    busy: false,
    chatHistory: []
  };

  const $ = (...ids) => {
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) return element;
    }
    return null;
  };

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

  const readStorage = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };

  const saveStorage = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('저장 실패:', error);
    }
  };

  function showMessage(message) {
    const loading = $('loading', 'loading-overlay');

    if (loading) {
      const text = loading.querySelector(
        '.loading-text, .loading-message, p, span'
      );

      if (text) {
        text.textContent = message;
      } else {
        loading.textContent = message;
      }
    }

    console.log('[공부킬러]', message);
  }

  function setBusy(busy, message = '') {
    state.busy = busy;

    const buttons = [
      $('uploadButton', 'analyze-button', 'analyzeButton', 'upload-button'),
      $('start-quiz', 'startQuiz', 'generateQuizButton')
    ].filter(Boolean);

    buttons.forEach(button => {
      button.disabled = busy;
    });

    const loading = $('loading', 'loading-overlay');

    if (loading) {
      loading.style.display = busy ? 'flex' : 'none';
    }

    if (message) showMessage(message);
  }

  function showError(message) {
    alert(message);
  }

  function getSelectedCount() {
    const selectors = [
      'questionCount',
      'questionCountSelect',
      'quizCount',
      'problemCount',
      'question-count',
      'count-grid'
    ];

    for (const id of selectors) {
      const element = document.getElementById(id);
      if (!element) continue;

      if (element.tagName === 'SELECT' || element.tagName === 'INPUT') {
        const value = Number(element.value);
        if (Number.isInteger(value) && value > 0) {
          return Math.min(value, 100);
        }
      }

      const active = element.querySelector(
        '[data-count].active, [data-count][aria-pressed="true"], .active'
      );

      if (active) {
        const value = Number(
          active.dataset.count ||
          active.textContent.match(/\d+/)?.[0]
        );

        if (Number.isInteger(value) && value > 0) {
          return Math.min(value, 100);
        }
      }
    }

    const checked = document.querySelector(
      'input[name="questionCount"]:checked, input[name="question-count"]:checked'
    );

    if (checked) {
      const value = Number(checked.value);
      if (value > 0) return Math.min(value, 100);
    }

    const selectedButton = document.querySelector(
      '[data-count].selected, [data-count].active, [data-count][aria-pressed="true"]'
    );

    if (selectedButton) {
      const value = Number(
        selectedButton.dataset.count ||
        selectedButton.textContent.match(/\d+/)?.[0]
      );

      if (value > 0) return Math.min(value, 100);
    }

    return state.selectedCount || 20;
  }

  function setSelectedCount(count) {
    state.selectedCount = Math.max(1, Math.min(100, Number(count) || 20));

    document.querySelectorAll('[data-count]').forEach(button => {
      const value = Number(button.dataset.count);

      const selected = value === state.selectedCount;

      button.classList.toggle('active', selected);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });

    const selectors = [
      'questionCount',
      'questionCountSelect',
      'quizCount',
      'problemCount',
      'question-count'
    ];

    selectors.forEach(id => {
      const element = document.getElementById(id);

      if (element && (
        element.tagName === 'SELECT' ||
        element.tagName === 'INPUT'
      )) {
        element.value = String(state.selectedCount);
      }
    });
  }

  function normalizeQuestion(question, index) {
    if (!question || typeof question !== 'object') return null;

    const text = String(
      question.question || question.text || ''
    ).trim();

    const options = Array.isArray(question.options)
      ? question.options.map(item => String(item).trim()).filter(Boolean)
      : [];

    const answer = Number(question.answer);

    if (
      !text ||
      options.length < 2 ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= options.length
    ) {
      return null;
    }

    return {
      id: question.id || `q-${index}-${Date.now()}`,
      question: text,
      options,
      answer,
      explanation: String(question.explanation || '해설이 없습니다.'),
      difficulty: String(question.difficulty || '보통'),
      concept: String(question.concept || '')
    };
  }

  function getFileInput() {
    return $('fileInput', 'quiz-doc', 'file-input', 'imageInput');
  }

  function updateFilePreview() {
    const nameArea = $('fileName', 'file-name', 'selectedFileName');
    const preview = $('imagePreview', 'image-preview');

    if (nameArea) {
      nameArea.textContent = state.files.length
        ? state.files.map(file => file.name).join(', ')
        : '선택된 파일이 없습니다.';
    }

    if (preview) {
      preview.innerHTML = '';

      state.files.forEach(file => {
        const image = document.createElement('img');
        image.alt = file.name;
        image.style.width = '100px';
        image.style.height = '100px';
        image.style.objectFit = 'cover';
        image.style.borderRadius = '10px';
        image.style.margin = '5px';

        const url = URL.createObjectURL(file);
        image.src = url;
        image.onload = () => URL.revokeObjectURL(url);

        preview.appendChild(image);
      });
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);

    if (!files.length) return;

    const images = files.filter(file => file.type.startsWith('image/'));

    if (images.length !== files.length) {
      showError('이미지 파일만 업로드할 수 있습니다.');
      return;
    }

    if (images.length > 6) {
      showError('이미지는 최대 6장까지 업로드할 수 있습니다.');
      return;
    }

    const tooLarge = images.find(file => file.size > 8 * 1024 * 1024);

    if (tooLarge) {
      showError('이미지 한 장의 용량은 8MB 이하여야 합니다.');
      return;
    }

    state.files = images;
    updateFilePreview();
  }

  function getTypedText() {
    const textArea = $(
      'studyText',
      'sourceText',
      'materialText',
      'inputText',
      'study-content'
    );

    return textArea ? textArea.value.trim() : '';
  }

  function getTitle() {
    const titleInput = $(
      'studyTitle',
      'titleInput',
      'materialTitle',
      'study-title'
    );

    return titleInput ? titleInput.value.trim() : '학습 자료';
  }

  async function analyzeStudyMaterial(requestedCount = null) {
    if (state.busy) return;

    const count = Math.max(
      1,
      Math.min(100, Number(requestedCount) || getSelectedCount())
    );

    const typedText = getTypedText();

    if (!state.files.length && !typedText) {
      showError('학습 자료 이미지 또는 텍스트를 먼저 올려 주세요.');
      return;
    }

    const formData = new FormData();

    formData.append('title', getTitle());
    formData.append('text', typedText);
    formData.append('questionCount', String(count));

    state.files.forEach(file => {
      formData.append('images', file);
    });

    setBusy(true, '자료를 인식하고 있습니다. 잠시만 기다려 주세요.');

    try {
      const response = await fetch(API.study, {
        method: 'POST',
        body: formData
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        const generated = data.generatedQuestionCount;
        const requested = data.requestedQuestionCount || count;

        let message = data.error || '자료 분석에 실패했습니다.';

        if (generated !== undefined) {
          message += `\n생성된 문제: ${generated}개 / 요청한 문제: ${requested}개`;
        }

        throw new Error(message);
      }

      const receivedQuestions = Array.isArray(data.questions)
        ? data.questions
            .map(normalizeQuestion)
            .filter(Boolean)
        : [];

      if (receivedQuestions.length !== count) {
        throw new Error(
          `문제 수가 일치하지 않습니다.\n요청: ${count}개\n생성: ${receivedQuestions.length}개\n다시 시도해 주세요.`
        );
      }

      state.result = data;
      state.questions = receivedQuestions;
      state.wrongQuestions = [];

      saveStorage(STORAGE.summary, data);
      saveStorage(STORAGE.title, getTitle());
      saveStorage(STORAGE.questions, receivedQuestions);
      saveStorage(STORAGE.wrong, []);
      saveStorage(STORAGE.source, data.sourceText || typedText);

      renderSummary(data);
      renderQuestionCount(receivedQuestions.length);

      showPage('summary');

    } catch (error) {
      console.error(error);
      showError(error.message || '자료 분석 중 오류가 발생했습니다.');
    } finally {
      setBusy(false);
    }
  }

  function renderQuestionCount(count) {
    const elements = [
      $('questionCountText'),
      $('generatedQuestionCount'),
      $('quizQuestionCount')
    ].filter(Boolean);

    elements.forEach(element => {
      element.textContent = `${count}문제 생성 완료`;
    });
  }

  function renderSummary(data) {
    const summaryArea = $(
      'summaryContent',
      'summary-content',
      'summaryResult'
    );

    if (!summaryArea) return;

    const summary = escapeHTML(data.summary || '요약 내용이 없습니다.')
      .replace(/\n/g, '<br>');

    const terms = Array.isArray(data.keyTerms)
      ? data.keyTerms
      : [];

    const points = Array.isArray(data.examPoints)
      ? data.examPoints
      : [];

    summaryArea.innerHTML = `
      <section class="study-summary">
        <h2>핵심 요약</h2>
        <div class="summary-text">${summary}</div>
      </section>

      <section class="study-keywords">
        <h2>중요 용어</h2>
        ${
          terms.length
            ? terms.map(item => `
              <article class="keyword-item">
                <strong>${escapeHTML(item.term || '')}</strong>
                <p>${escapeHTML(item.meaning || '')}</p>
              </article>
            `).join('')
            : '<p>중요 용어가 없습니다.</p>'
        }
      </section>

      <section class="study-exam-points">
        <h2>시험 핵심 포인트</h2>
        ${
          points.length
            ? `<ul>${points.map(point => `
              <li>${escapeHTML(point)}</li>
            `).join('')}</ul>`
            : '<p>시험 포인트가 없습니다.</p>'
        }
      </section>

      <p class="generated-count">
        총 ${state.questions.length}문제 생성 완료
      </p>
    `;
  }

  function showPage(pageName) {
    const aliases = {
      upload: ['upload', 'uploadPage', 'page-upload'],
      summary: ['summary', 'summaryPage', 'page-summary'],
      quiz: ['quiz', 'quizPage', 'page-quiz'],
      quizResult: ['quizResult', 'result', 'resultPage', 'page-result'],
      wrong: ['wrong', 'wrongPage', 'wrong-note', 'page-wrong']
    };

    const allPages = document.querySelectorAll(
      'main .page, .page[data-page], .app-page'
    );

    allPages.forEach(page => {
      page.classList.remove('active');
      page.style.display = 'none';
    });

    const candidates = aliases[pageName] || [pageName];

    let target = null;

    for (const id of candidates) {
      target = document.getElementById(id);
      if (target) break;
    }

    if (target) {
      target.classList.add('active');
      target.style.display = '';
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }

  function startQuiz(count = null) {
    const requested = Math.max(
      1,
      Math.min(100, Number(count) || getSelectedCount())
    );

    if (!state.questions.length) {
      showError('먼저 학습 자료를 분석해 주세요.');
      showPage('upload');
      return;
    }

    if (state.questions.length < requested) {
      showError(
        `현재 ${state.questions.length}문제만 준비되어 있습니다.\n${requested}문제를 풀려면 자료를 다시 분석해 주세요.`
      );
      return;
    }

    state.quizQuestions = state.questions.slice(0, requested);
    state.currentIndex = 0;
    state.correctCount = 0;
    state.answers = [];
    state.wrongQuestions = [];

    showPage('quiz');
    renderCurrentQuestion();
  }

  function renderCurrentQuestion() {
    const question = state.quizQuestions[state.currentIndex];

    if (!question) {
      finishQuiz();
      return;
    }

    const number = state.currentIndex + 1;
    const total = state.quizQuestions.length;

    const numberElement = $('questionNumber', 'currentQuestionNumber');
    const progress = $('quizProgress', 'progressBar');
    const questionArea = $('quizQuestion', 'questionText');
    const optionsArea = $('quizOptions', 'optionsArea');

    if (numberElement) {
      numberElement.textContent = `${number} / ${total}`;
    }

    if (progress) {
      const percent = (number / total) * 100;

      if (progress.tagName === 'PROGRESS') {
        progress.max = 100;
        progress.value = percent;
      } else {
        progress.style.width = `${percent}%`;
        progress.setAttribute('aria-valuenow', String(percent));
      }
    }

    if (questionArea) {
      questionArea.textContent = question.question;
    }

    if (optionsArea) {
      optionsArea.innerHTML = question.options.map((option, index) => `
        <button
          type="button"
          class="quiz-option"
          data-option="${index}"
        >
          <span class="option-number">${index + 1}</span>
          <span>${escapeHTML(option)}</span>
        </button>
      `).join('');

      optionsArea.querySelectorAll('[data-option]').forEach(button => {
        button.addEventListener('click', () => {
          selectAnswer(Number(button.dataset.option));
        });
      });
    }

    const feedback = $('quizFeedback', 'quiz-feedback');

    if (feedback) {
      feedback.innerHTML = '';
    }

    const nextButton = $('nextQuestion', 'next-question', 'nextButton');

    if (nextButton) {
      nextButton.style.display = 'none';
    }
  }

  function selectAnswer(selectedIndex) {
    if (state.answers[state.currentIndex] !== undefined) return;

    const question = state.quizQuestions[state.currentIndex];
    const correct = selectedIndex === question.answer;

    state.answers[state.currentIndex] = selectedIndex;

    if (correct) {
      state.correctCount++;
    } else {
      state.wrongQuestions.push({
        ...question,
        userAnswer: selectedIndex
      });
    }

    const optionsArea = $('quizOptions', 'optionsArea');

    if (optionsArea) {
      optionsArea.querySelectorAll('[data-option]').forEach(button => {
        const index = Number(button.dataset.option);

        button.disabled = true;

        if (index === question.answer) {
          button.classList.add('correct');
        } else if (index === selectedIndex) {
          button.classList.add('incorrect');
        }
      });
    }

    const feedback = $('quizFeedback', 'quiz-feedback');

    if (feedback) {
      feedback.innerHTML = `
        <div class="${correct ? 'correct-feedback' : 'wrong-feedback'}">
          <strong>${correct ? '정답입니다!' : '오답입니다.'}</strong>
          <p>정답: ${escapeHTML(question.options[question.answer])}</p>
          <p>${escapeHTML(question.explanation)}</p>
        </div>
      `;
    }

    const nextButton = $('nextQuestion', 'next-question', 'nextButton');

    if (nextButton) {
      nextButton.style.display = 'block';
      nextButton.textContent =
        state.currentIndex + 1 === state.quizQuestions.length
          ? '결과 확인'
          : '다음 문제';
    }
  }

  function nextQuestion() {
    if (state.answers[state.currentIndex] === undefined) {
      showError('먼저 답을 선택해 주세요.');
      return;
    }

    state.currentIndex++;

    if (state.currentIndex >= state.quizQuestions.length) {
      finishQuiz();
      return;
    }

    renderCurrentQuestion();
  }

  function finishQuiz() {
    const total = state.quizQuestions.length;
    const wrongCount = total - state.correctCount;
    const score = total
      ? Math.round((state.correctCount / total) * 100)
      : 0;

    saveStorage(STORAGE.wrong, state.wrongQuestions);

    const resultArea = $('resultContent', 'result-content');

    if (resultArea) {
      resultArea.innerHTML = `
        <div class="quiz-result">
          <h2>퀴즈 결과</h2>
          <div class="result-score">${score}점</div>
          <p>전체 문제: ${total}개</p>
          <p>정답: ${state.correctCount}개</p>
          <p>오답: ${wrongCount}개</p>
        </div>
      `;
    }

    renderWrongList();
    showPage('quizResult');
  }

  function renderWrongList() {
    const wrongArea = $('wrongList', 'wrong-list', 'wrongContent');

    if (!wrongArea) return;

    if (!state.wrongQuestions.length) {
      wrongArea.innerHTML = '<p>틀린 문제가 없습니다. 잘하셨습니다!</p>';
      return;
    }

    wrongArea.innerHTML = state.wrongQuestions.map((question, index) => `
      <article class="wrong-question">
        <h3>${index + 1}. ${escapeHTML(question.question)}</h3>
        <p>
          내가 선택한 답:
          ${escapeHTML(question.options[question.userAnswer] || '미응답')}
        </p>
        <p>
          정답:
          ${escapeHTML(question.options[question.answer])}
        </p>
        <p>해설: ${escapeHTML(question.explanation)}</p>
      </article>
    `).join('');
  }

  function retryWrongAnswers() {
    if (!state.wrongQuestions.length) {
      showError('다시 풀 오답 문제가 없습니다.');
      return;
    }

    state.quizQuestions = state.wrongQuestions.map(question => ({
      ...question
    }));

    state.currentIndex = 0;
    state.correctCount = 0;
    state.answers = [];
    state.wrongQuestions = [];

    showPage('quiz');
    renderCurrentQuestion();
  }

  async function sendChatMessage() {
    if (state.busy) return;

    const input = $('chatInput', 'chat-input', 'messageInput');
    const message = input?.value.trim();

    if (!message) return;

    const messagesArea = $('chatMessages', 'chat-messages');

    if (messagesArea) {
      messagesArea.insertAdjacentHTML(
        'beforeend',
        `<div class="chat-message user-message">${escapeHTML(message)}</div>`
      );
    }

    input.value = '';

    const context = state.result?.sourceText ||
      readStorage(STORAGE.source, '');

    const history = state.chatHistory.slice(-10);

    state.chatHistory.push({
      role: 'user',
      content: message
    });

    try {
      const response = await fetch(API.chat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message,
          context,
          history
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        throw new Error(data.error || '채팅 응답을 받지 못했습니다.');
      }

      const answer = data.answer || '답변이 비어 있습니다.';

      state.chatHistory.push({
        role: 'assistant',
        content: answer
      });

      saveStorage(STORAGE.chat, state.chatHistory);

      if (messagesArea) {
        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message assistant-message';
        messageElement.textContent = answer;
        messagesArea.appendChild(messageElement);
        messagesArea.scrollTop = messagesArea.scrollHeight;
      }

    } catch (error) {
      console.error(error);
      showError(error.message);
    }
  }

  function bindEvents() {
    const fileInput = getFileInput();

    if (fileInput) {
      fileInput.addEventListener('change', event => {
        handleFiles(event.target.files);
      });
    }

    const uploadButton = $(
      'uploadButton',
      'analyze-button',
      'analyzeButton',
      'upload-button'
    );

    if (uploadButton) {
      uploadButton.addEventListener('click', () => {
        analyzeStudyMaterial();
      });
    }

    const startButton = $(
      'start-quiz',
      'startQuiz',
      'generateQuizButton'
    );

    if (startButton) {
      startButton.addEventListener('click', () => {
        startQuiz();
      });
    }

    const nextButton = $(
      'nextQuestion',
      'next-question',
      'nextButton'
    );

    if (nextButton) {
      nextButton.addEventListener('click', nextQuestion);
    }

    const retryButton = $(
      'retryWrong',
      'retry-wrong',
      'retryWrongButton'
    );

    if (retryButton) {
      retryButton.addEventListener('click', retryWrongAnswers);
    }

    const chatButton = $('chatSend', 'chat-send', 'sendMessage');

    if (chatButton) {
      chatButton.addEventListener('click', sendChatMessage);
    }

    const chatInput = $('chatInput', 'chat-input', 'messageInput');

    if (chatInput) {
      chatInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendChatMessage();
        }
      });
    }

    document.addEventListener('click', event => {
      const countButton = event.target.closest('[data-count]');

      if (countButton) {
        const count = Number(countButton.dataset.count);

        if (Number.isInteger(count) && count > 0) {
          setSelectedCount(count);
        }
      }

      const pageButton = event.target.closest('[data-page-target]');

      if (pageButton) {
        showPage(pageButton.dataset.pageTarget);
      }
    });

    const countSelect = $(
      'questionCount',
      'questionCountSelect',
      'quizCount',
      'problemCount',
      'question-count'
    );

    if (countSelect) {
      countSelect.addEventListener('change', () => {
        setSelectedCount(countSelect.value);
      });
    }
  }

  function restoreData() {
    const savedQuestions = readStorage(STORAGE.questions, []);
    const savedSummary = readStorage(STORAGE.summary, null);
    const savedWrong = readStorage(STORAGE.wrong, []);
    const savedChat = readStorage(STORAGE.chat, []);

    if (Array.isArray(savedQuestions)) {
      state.questions = savedQuestions
        .map(normalizeQuestion)
        .filter(Boolean);
    }

    if (savedSummary) {
      state.result = savedSummary;
      renderSummary(savedSummary);
    }

    if (Array.isArray(savedWrong)) {
      state.wrongQuestions = savedWrong;
    }

    if (Array.isArray(savedChat)) {
      state.chatHistory = savedChat;
    }

    renderQuestionCount(state.questions.length);
  }

  function initialize() {
    bindEvents();
    restoreData();
    setSelectedCount(20);

    window.analyzeStudyMaterial = analyzeStudyMaterial;
    window.generateQuiz = startQuiz;
    window.startQuiz = startQuiz;
    window.nextQuestion = nextQuestion;
    window.retryWrongAnswers = retryWrongAnswers;
    window.sendChatMessage = sendChatMessage;
    window.showPage = showPage;

    console.log('공부킬러 app.js 초기화 완료');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();

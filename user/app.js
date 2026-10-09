(() => {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const VOICE_PREFERENCE_KEY = "meusOlhos.voiceEnabled";
  const DESCRIPTION_URL = "/api/ai/analyze";
  const QUESTION_URL = "/api/ai/ask-image";
  const INTRODUCTION =
    "Olá! Bem-vindo ao Meus Olhos, seu assistente visual. Eu posso ajudar você a entender o que está ao seu redor. Posso tirar uma foto e descrever objetos, pessoas e ambientes, ler textos que apareçam na imagem e responder perguntas sobre aquilo que você fotografou. Por exemplo, você pode perguntar o que está escrito em uma placa ou qual é a cor de uma roupa. Para começar, precisamos configurar o acesso ao microfone e à câmera. Depois, basta dizer: Olá, Olhos. Eu vou orientar você durante todo o processo.";
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const STATES = Object.freeze({
    WAITING_WAKE: "aguardando_ativacao",
    GREETING: "atendendo",
    ORIENTING_PHOTO: "orientando_foto",
    WAITING_CAPTURE: "aguardando_captura",
    CAPTURING: "capturando_foto",
    ANALYZING: "analisando_foto",
    WAITING_QUESTION: "aguardando_pergunta",
    ANSWERING: "respondendo_pergunta",
    RETURNING: "retornando_espera",
    PAUSED: "escuta_pausada",
    NEEDS_SETUP: "configuracao_necessaria",
    CAMERA_ERROR: "camera_indisponivel"
  });

  const elements = {
    listenIntroduction: document.getElementById("listen-introduction"),
    introductionStatus: document.getElementById("introduction-status"),
    setupVoice: document.getElementById("setup-voice"),
    voiceToggle: document.getElementById("voice-toggle"),
    voiceState: document.getElementById("voice-state"),
    permissionStatus: document.getElementById("permission-status"),
    fallbackNotice: document.getElementById("fallback-notice"),
    fallbackMessage: document.getElementById("fallback-message"),
    retryVoice: document.getElementById("retry-voice"),
    retryAnalysis: document.getElementById("retry-analysis"),
    openCamera: document.getElementById("open-camera"),
    pauseSpeech: document.getElementById("pause-speech"),
    stopSpeech: document.getElementById("stop-speech"),
    cancelPhoto: document.getElementById("cancel-photo"),
    cameraSection: document.getElementById("camera-section"),
    cameraPreview: document.getElementById("camera-preview"),
    capturePhoto: document.getElementById("capture-photo"),
    closeCamera: document.getElementById("close-camera"),
    filePickerButton: document.getElementById("file-picker-button"),
    photoFile: document.getElementById("photo-file"),
    photoSection: document.getElementById("photo-section"),
    photoPreview: document.getElementById("photo-preview"),
    questionForm: document.getElementById("question-form"),
    question: document.getElementById("question"),
    retakePhoto: document.getElementById("retake-photo"),
    listenAgain: document.getElementById("listen-again"),
    status: document.getElementById("status"),
    voiceStatus: document.getElementById("voice-status")
  };

  let assistantState = STATES.NEEDS_SETUP;
  let microphonePermissionGranted = false;
  let voiceEnabled = false;
  let speechActive = false;
  let speechPaused = false;
  let setupInProgress = false;

  let recognizer = null;
  let recognitionRunning = false;
  let recognitionStarting = false;
  let recognitionStopRequested = false;
  let desiredRecognitionMode = null;
  let recognitionRestartTimer = null;
  let recognitionRestartDelay = 500;
  let handledRecognitionResult = -1;

  let cameraStream = null;
  let cameraOpening = false;
  let captureInProgress = false;
  let photoBlob = null;
  let photoUrl = null;
  let photoGeneration = 0;
  let analysisInProgress = false;
  let questionInProgress = false;
  let questionController = null;
  let lastQuestion = "";
  let lastAnswer = "";
  let speechToken = 0;
  let speechContinuation = null;
  let lastAnalysisFailed = false;
  let introductionPlaybackActive = false;

  const stateMessages = {
    [STATES.WAITING_WAKE]: "Aguardando “Olá, Olhos”.",
    [STATES.GREETING]: "Atendimento iniciado.",
    [STATES.ORIENTING_PHOTO]: "Orientando para a foto.",
    [STATES.WAITING_CAPTURE]: "Câmera pronta. Aguardando o comando “tirar foto”.",
    [STATES.CAPTURING]: "Capturando uma foto.",
    [STATES.ANALYZING]: "Analisando a foto.",
    [STATES.WAITING_QUESTION]: "Aguardando uma pergunta sobre a foto.",
    [STATES.ANSWERING]: "Respondendo à pergunta.",
    [STATES.RETURNING]: "Voltando ao modo de espera.",
    [STATES.PAUSED]: "Escuta pausada.",
    [STATES.NEEDS_SETUP]: "Permita o microfone para configurar o assistente de voz.",
    [STATES.CAMERA_ERROR]: "Não foi possível abrir a câmera."
  };

  function setState(state, message = stateMessages[state]) {
    assistantState = state;
    elements.status.textContent = message || "";
  }
  setFallback("");

  function setFallback(message, showRetryVoice = false, showRetryAnalysis = false) {
    elements.fallbackNotice.hidden = !message;
    elements.fallbackMessage.textContent = message || "";
    elements.retryVoice.hidden = !message || !showRetryVoice;
    elements.retryAnalysis.hidden = !message || !showRetryAnalysis;
  }

  function storeVoicePreference(enabled) {
    try {
      window.localStorage.setItem(VOICE_PREFERENCE_KEY, enabled ? "true" : "false");
    } catch (error) {
      setFallback("Não foi possível salvar a preferência de escuta. Ela valerá somente nesta visita.");
    }
  }

  function setVoiceStatus(message) {
    elements.voiceStatus.textContent = message;
    if (message && voiceEnabled) {
      elements.voiceState.textContent = message;
    }
  }

  function normalizeCommand(text) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function containsWakePhrase(command) {
    return /(^|\s)ola(?:\s+meus)?\s+olhos?(?=\s|$)/.test(command);
  }

  function removeWakePhrase(command) {
    return command
      .replace(/(^|\s)ola(?:\s+meus)?\s+olhos?(?=\s|$)/, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function removeWakePhraseFromTranscript(transcript) {
    return transcript
      .replace(/(^|\s)ol[áa]\s+(?:(?:meus?|minhas?)\s+)?olhos?(?=[\s,.!?]|$)/i, " ")
      .replace(/^[\s,.!?]+|[\s,.!?]+$/g, "")
      .trim();
  }

  function getWakePrefixedCommand(transcript) {
    const normalized = normalizeCommand(transcript);
    if (!containsWakePhrase(normalized)) {
      return null;
    }
    return removeWakePhrase(normalized);
  }

  function recognitionModeForState() {
    if (assistantState === STATES.WAITING_CAPTURE) {
      return "capture";
    }
    if (assistantState === STATES.WAITING_QUESTION) {
      return "question";
    }
    if (assistantState === STATES.GREETING || assistantState === STATES.CAMERA_ERROR) {
      return "command";
    }
    return "wake";
  }

  function requestContainsPhoto(command) {
    return [
      "tirar foto",
      "tire foto",
      "tire uma foto",
      "tirar uma foto",
      "tirar fotografia",
      "tirar uma fotografia",
      "nova foto",
      "outra foto",
      "fotografar",
      "fotografe",
      "capturar foto",
      "capturar uma foto",
      "bater foto",
      "bater uma foto"
    ].some((phrase) => command.includes(phrase));
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    elements.cameraPreview.srcObject = null;
    elements.cameraPreview.hidden = true;
    elements.capturePhoto.hidden = true;
    elements.closeCamera.hidden = true;
  }

  function releasePhoto() {
    photoGeneration += 1;
    photoBlob = null;
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    elements.photoPreview.removeAttribute("src");
    elements.photoSection.hidden = true;
    elements.question.value = "";
    elements.listenAgain.hidden = true;
    lastQuestion = "";
    lastAnswer = "";
    lastAnalysisFailed = false;
    setFallback("");
  }

  function stopRecognizer() {
    if (recognitionRestartTimer) {
      window.clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = null;
    }
    desiredRecognitionMode = null;
    if (!recognizer || (!recognitionRunning && !recognitionStarting)) {
      return;
    }

    recognitionStopRequested = true;
    try {
      recognizer.stop();
    } catch (error) {
      if (error.name === "InvalidStateError") {
        recognitionRunning = false;
        recognitionStarting = false;
        recognitionStopRequested = false;
      } else {
        setVoiceStatus("Não foi possível pausar o reconhecimento de voz.");
      }
    }
  }

  function setRecognitionMode(mode) {
    if (!voiceEnabled || !microphonePermissionGranted || !SpeechRecognition) {
      return;
    }
    desiredRecognitionMode = mode;

    if (document.visibilityState === "hidden" || speechActive) {
      return;
    }

    if (recognitionRunning || recognitionStarting) {
      if (recognitionStopRequested) {
        return;
      }
      recognitionStopRequested = true;
      try {
        recognizer.stop();
      } catch (error) {
        if (error.name === "InvalidStateError") {
          recognitionRunning = false;
          recognitionStarting = false;
          recognitionStopRequested = false;
          scheduleRecognitionRestart(100);
        } else {
          setVoiceStatus("O reconhecimento foi interrompido. Tentando retomar.");
        }
      }
      return;
    }
    startRecognizer();
  }

  function scheduleRecognitionRestart(delay = recognitionRestartDelay) {
    if (
      recognitionRestartTimer ||
      !voiceEnabled ||
      !desiredRecognitionMode ||
      document.visibilityState === "hidden" ||
      speechActive
    ) {
      return;
    }
    setFallback("");
    recognitionRestartTimer = window.setTimeout(() => {
      recognitionRestartTimer = null;
      startRecognizer();
    }, delay);
  }

  function startRecognizer() {
    if (
      !voiceEnabled ||
      !microphonePermissionGranted ||
      !desiredRecognitionMode ||
      document.visibilityState === "hidden" ||
      speechActive ||
      recognitionRunning ||
      recognitionStarting ||
      !recognizer
    ) {
      return;
    }

    try {
      recognitionStarting = true;
      recognitionStopRequested = false;
      recognizer.start();
    } catch (error) {
      recognitionStarting = false;
      if (error.name === "InvalidStateError") {
        scheduleRecognitionRestart(300);
        return;
      }
      handleRecognitionError(error.name === "NotAllowedError" ? "not-allowed" : "start-failed");
    }
  }

  function ensureRecognizer() {
    if (!SpeechRecognition) {
      return false;
    }
    if (recognizer) {
      return true;
    }

    recognizer = new SpeechRecognition();
    recognizer.lang = "pt-BR";
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.onstart = () => {
      recognitionRunning = true;
      recognitionStarting = false;
      recognitionStopRequested = false;
      recognitionRestartDelay = 500;
      handledRecognitionResult = -1;
      const mode = desiredRecognitionMode;
      if (!mode || !voiceEnabled || speechActive) {
        recognitionStopRequested = true;
        recognizer.stop();
        return;
      }
      if (mode === "wake") {
        setState(STATES.WAITING_WAKE, "Estou ouvindo “Olá, Olhos”.");
        elements.voiceState.textContent = "Escuta ativa: aguardando “Olá, Olhos”.";
      } else if (mode === "capture") {
        setState(STATES.WAITING_CAPTURE);
        elements.voiceState.textContent = "Escuta ativa: diga “Olá, Olhos, tirar foto” ou “tirar foto”.";
      } else if (mode === "question") {
        setState(STATES.WAITING_QUESTION);
        elements.voiceState.textContent = "Escuta ativa: aguardando sua pergunta sobre a foto.";
      } else if (mode === "command") {
        elements.voiceState.textContent = "Escuta ativa: aguardando seu comando.";
      }
    };

    recognizer.onresult = (event) => {
      if (!recognitionRunning || recognitionStopRequested || speechActive) {
        return;
      }
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result.isFinal || index === handledRecognitionResult) {
          continue;
        }
        handledRecognitionResult = index;
        const transcript = result[0]?.transcript?.trim();
        if (transcript) {
          handleVoiceInput(transcript);
        }
        if (
          !recognitionRunning ||
          recognitionStopRequested ||
          speechActive ||
          assistantState === STATES.CAPTURING ||
          assistantState === STATES.ANALYZING ||
          assistantState === STATES.ANSWERING
        ) {
          return;
        }
      }
    };

    recognizer.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        return;
      }
      handleRecognitionError(event.error);
    };

    recognizer.onend = () => {
      recognitionRunning = false;
      recognitionStarting = false;
      recognitionStopRequested = false;
      handledRecognitionResult = -1;

      if (!voiceEnabled || !desiredRecognitionMode || speechActive) {
        return;
      }
      if (document.visibilityState === "hidden") {
        elements.voiceState.textContent = "Escuta pausada enquanto a página está em segundo plano.";
        return;
      }

      elements.voiceState.textContent = "O reconhecimento foi interrompido. Tentando retomar a escuta.";
      const delay = recognitionRestartDelay;
      recognitionRestartDelay = Math.min(recognitionRestartDelay * 2, 8_000);
      scheduleRecognitionRestart(delay);
    };
    return true;
  }

  function handleRecognitionError(error) {
    const resumeMode = desiredRecognitionMode || recognitionModeForState();
    const messages = {
      "not-allowed": "O navegador negou o acesso ao microfone. Confira as permissões do site.",
      "service-not-allowed": "O serviço de reconhecimento de voz não está disponível neste navegador.",
      "audio-capture": "Não consegui acessar o microfone. Verifique a permissão e tente novamente.",
      network: "O reconhecimento de fala foi interrompido por um problema de rede. Vou tentar retomar.",
      "start-failed": "Não consegui iniciar o reconhecimento de voz."
    };
    const message = messages[error] || "O reconhecimento de voz foi interrompido.";
    elements.voiceState.textContent = message;
    setFallback(`${message} Você pode tentar novamente ou digitar sua pergunta.`, true);

    if (error === "not-allowed" || error === "service-not-allowed" || error === "audio-capture") {
      voiceEnabled = false;
      microphonePermissionGranted = false;
      storeVoicePreference(false);
      elements.setupVoice.hidden = false;
      elements.setupVoice.textContent = "Tentar configuração por voz novamente";
      elements.voiceToggle.hidden = true;
      desiredRecognitionMode = null;
      setState(STATES.NEEDS_SETUP, message);
      if (!speechActive) {
        speak(message);
      }
      return;
    }

    if (error === "network" || error === "start-failed") {
      recognitionRestartDelay = Math.max(recognitionRestartDelay, 1_500);
      if (!speechActive) {
        speak("A escuta foi interrompida. Vou tentar retomá-la.", () =>
          setRecognitionMode(resumeMode)
        );
      } else {
        scheduleRecognitionRestart();
      }
    }
  }

  function continueAfterSpeech(token, callback) {
    if (token !== speechToken) {
      return;
    }
    speechActive = false;
    speechPaused = false;
    elements.pauseSpeech.hidden = true;
    elements.stopSpeech.hidden = true;
    const continuation = speechContinuation;
    speechContinuation = null;
    if (typeof callback === "function") {
      callback();
    } else if (typeof continuation === "function") {
      continuation();
    } else if (voiceEnabled) {
      setRecognitionMode("wake");
    }
  }

  function speak(text, onEnd) {
    stopRecognizer();
    if (
      !("speechSynthesis" in window) ||
      typeof window.SpeechSynthesisUtterance !== "function"
    ) {
      speechActive = false;
      setFallback("A voz do navegador não está disponível. Use os controles acessíveis na página.");
      if (typeof onEnd === "function") {
        onEnd();
      } else if (voiceEnabled) {
        setRecognitionMode("wake");
      }
      return false;
    }

    const token = ++speechToken;
    speechContinuation = onEnd;
    speechActive = true;
    speechPaused = false;
    window.speechSynthesis.cancel();

    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    const voice = window.speechSynthesis
      .getVoices()
      .find((item) => /^pt-BR$/i.test(item.lang));
    if (voice) {
      utterance.voice = voice;
    }

    elements.pauseSpeech.hidden = false;
    elements.pauseSpeech.textContent = "Pausar fala";
    elements.stopSpeech.hidden = false;
    if (voiceEnabled) {
      elements.voiceState.textContent = "Escuta pausada enquanto o Olhos fala.";
    }
    utterance.onend = () => continueAfterSpeech(token, onEnd);
    utterance.onerror = () => {
      if (token !== speechToken) {
        return;
      }
      setFallback("A reprodução da voz foi interrompida. Você pode usar os controles da página.");
      continueAfterSpeech(token, onEnd);
    };

    try {
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      setFallback("Não consegui reproduzir a fala. As instruções também estão na tela.");
      continueAfterSpeech(token, onEnd);
      return false;
    }
  }

  function stopSpeechAndContinue() {
    if (!speechActive) {
      return;
    }
    const continuation = speechContinuation;
    speechToken += 1;
    speechContinuation = null;
    speechActive = false;
    speechPaused = false;
    elements.pauseSpeech.hidden = true;
    elements.stopSpeech.hidden = true;
    window.speechSynthesis.cancel();
    if (typeof continuation === "function") {
      continuation();
    } else if (voiceEnabled) {
      setRecognitionMode("wake");
    }
  }

  function toggleSpeechPause() {
    if (!speechActive) {
      return;
    }
    if (speechPaused) {
      window.speechSynthesis.resume();
      speechPaused = false;
      elements.pauseSpeech.textContent = "Pausar fala";
      elements.status.textContent = "Retomando a fala.";
    } else {
      window.speechSynthesis.pause();
      speechPaused = true;
      elements.pauseSpeech.textContent = "Retomar fala";
      elements.status.textContent = "Fala pausada.";
    }
  }

  function setVoiceEnabled(enabled, { persist = true, startListening = true } = {}) {
    voiceEnabled = enabled;
    if (persist) {
      storeVoicePreference(enabled);
    }
    elements.voiceToggle.hidden = !microphonePermissionGranted || !SpeechRecognition;
    elements.voiceToggle.textContent = enabled ? "Pausar escuta" : "Retomar escuta";
    elements.voiceToggle.setAttribute("aria-pressed", String(enabled));

    if (enabled && startListening) {
      setRecognitionMode("wake");
    } else if (!enabled) {
      stopRecognizer();
      setState(STATES.PAUSED);
      elements.voiceState.textContent = "Escuta pausada. Toque em retomar para voltar a ouvir.";
    }
  }

  async function queryMicrophonePermission() {
    if (!navigator.permissions?.query) {
      return "unknown";
    }
    try {
      const result = await navigator.permissions.query({ name: "microphone" });
      return result.state;
    } catch (error) {
      return "unknown";
    }
  }

  async function refreshPermissionState() {
    const permission = await queryMicrophonePermission();
    if (setupInProgress || voiceEnabled) {
      return;
    }
    if (permission === "granted") {
      elements.permissionStatus.textContent =
        "Microfone permitido. Toque em “Começar configuração” para iniciar a escuta.";
    } else if (permission === "denied") {
      microphonePermissionGranted = false;
      voiceEnabled = false;
      elements.permissionStatus.textContent =
        "Microfone bloqueado. Habilite a permissão nas configurações do navegador e toque em “Começar configuração” para tentar novamente.";
      setFallback(elements.permissionStatus.textContent);
      elements.setupVoice.textContent = "Tentar configuração novamente";
      setState(STATES.NEEDS_SETUP, elements.permissionStatus.textContent);
    } else {
      elements.permissionStatus.textContent =
        permission === "prompt"
          ? "O acesso ao microfone só será solicitado quando você tocar em “Começar configuração”."
          : "O estado da permissão não está disponível. O acesso só será solicitado quando você tocar em “Começar configuração”.";
    }
    elements.setupVoice.hidden = false;
    elements.voiceToggle.hidden = true;
  }

  async function requestMicrophonePermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return {
        granted: false,
        message: "Este navegador não permite acessar o microfone. Você ainda pode tirar uma foto e digitar perguntas."
      };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      stream.getTracks().forEach((track) => track.stop());
      microphonePermissionGranted = true;
      return {
        granted: true,
        message: "A permissão do microfone foi confirmada. O Meus Olhos não grava o áudio."
      };
    } catch (error) {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      microphonePermissionGranted = false;
      return {
        granted: false,
        message:
          error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
            ? "O acesso ao microfone foi negado. Habilite-o nas configurações do navegador."
            : "Não consegui acessar o microfone. Verifique a permissão e tente novamente."
      };
    }
  }

  function beginMicrophoneSetup() {
    if (setupInProgress) {
      return;
    }
    if (!SpeechRecognition) {
      const message =
        "Este navegador não oferece reconhecimento de voz compatível. Você pode tirar ou escolher uma foto e digitar suas perguntas.";
      setFallback(message);
      setState(STATES.NEEDS_SETUP, message);
      speak(message);
      return;
    }
    if (!("speechSynthesis" in window)) {
      elements.permissionStatus.textContent =
        "A voz do navegador não está disponível. Leia as instruções na tela para conceder acesso ao microfone.";
    }

    if (introductionPlaybackActive) {
      introductionPlaybackActive = false;
      elements.introductionStatus.textContent =
        "Apresentação interrompida para iniciar a configuração.";
    }
    setupInProgress = true;
    elements.setupVoice.disabled = true;
    setFallback("");
    const requestPermission = async () => {
      const result = await requestMicrophonePermission();
      elements.permissionStatus.textContent = result.message;
      setupInProgress = false;
      elements.setupVoice.disabled = false;

      if (!result.granted) {
        elements.setupVoice.textContent = "Tentar configuração por voz novamente";
        setState(STATES.NEEDS_SETUP, result.message);
        setFallback(
          `${result.message} Sem microfone, use os botões da página e digite sua pergunta.`
        );
        speak(result.message);
        return;
      }

      ensureRecognizer();
      elements.setupVoice.hidden = true;
      setVoiceEnabled(true, { startListening: false });
      speak(
        "Configuração concluída. Estou aguardando você dizer “Olá, Olhos”.",
        () => setRecognitionMode("wake")
      );
    };

    speak(
      "Vou solicitar acesso ao microfone para reconhecer “Olá, Olhos” e suas perguntas. O áudio não será gravado pelo Meus Olhos.",
      requestPermission
    );
  }

  async function openCamera() {
    if (cameraOpening || cameraStream) {
      return Boolean(cameraStream);
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "A câmera direta não está disponível. Use “Tirar ou escolher uma foto” para continuar."
      );
    }

    cameraOpening = true;
    elements.cameraSection.hidden = false;
    elements.filePickerButton.hidden = false;
    elements.cameraPreview.hidden = true;
    elements.capturePhoto.hidden = true;
    elements.closeCamera.hidden = true;
    elements.status.textContent = "Abrindo a câmera traseira. Aguarde.";

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } }
      });
      elements.cameraPreview.srcObject = cameraStream;
      elements.cameraPreview.hidden = false;
      await elements.cameraPreview.play();
      if (!elements.cameraPreview.videoWidth) {
        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("A câmera não ficou pronta. Tente novamente.")),
            8_000
          );
          elements.cameraPreview.addEventListener(
            "loadedmetadata",
            () => {
              window.clearTimeout(timeout);
              resolve();
            },
            { once: true }
          );
        });
      }
      elements.capturePhoto.hidden = false;
      elements.closeCamera.hidden = false;
      elements.status.textContent = "Câmera pronta.";
      return true;
    } catch (error) {
      stopCamera();
      throw error;
    } finally {
      cameraOpening = false;
    }
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Não foi possível preparar a foto."));
          }
        },
        "image/jpeg",
        quality
      );
    });
  }

  async function capturePhoto() {
    if (
      captureInProgress ||
      analysisInProgress ||
      assistantState !== STATES.WAITING_CAPTURE
    ) {
      return;
    }
    if (
      !cameraStream ||
      !elements.cameraPreview.videoWidth ||
      !elements.cameraPreview.videoHeight
    ) {
      await handleCameraFailure(new Error("A câmera ainda não está pronta. Tente novamente."));
      return;
    }

    captureInProgress = true;
    setState(STATES.CAPTURING);
    stopRecognizer();
    elements.capturePhoto.disabled = true;
    const canvas = document.createElement("canvas");
    canvas.width = elements.cameraPreview.videoWidth;
    canvas.height = elements.cameraPreview.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      canvas.width = 0;
      canvas.height = 0;
      captureInProgress = false;
      elements.capturePhoto.disabled = false;
      await handleCameraFailure(new Error("Não foi possível preparar a foto."));
      return;
    }

    try {
      context.drawImage(
        elements.cameraPreview,
        0,
        0,
        canvas.width,
        canvas.height
      );
      const captured = await canvasToJpeg(canvas, 0.95);
      if (!captured || captured.size === 0) {
        throw new Error("A câmera não produziu uma imagem válida.");
      }
      if (captured.size > MAX_IMAGE_BYTES) {
        throw new Error("A foto ultrapassa 8 MiB. Tente aproximar o celular e tirar outra.");
      }

      releasePhoto();
      photoBlob = captured;
      photoUrl = URL.createObjectURL(captured);
      elements.photoPreview.src = photoUrl;
      elements.photoSection.hidden = false;
      elements.question.value = "";
      elements.capturePhoto.disabled = false;
      stopCamera();
      captureInProgress = false;

      speak("Pronto! Tirei a foto. Vou analisar o que aparece nela.", () => {
        analyzePhoto(captured);
      });
    } catch (error) {
      elements.capturePhoto.disabled = false;
      captureInProgress = false;
      await handleCameraFailure(error);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function requestJson(url, image, question) {
    const headers = { "Content-Type": image.type };
    const endpoint =
      question === undefined
        ? url
        : `${url}?question=${encodeURIComponent(question)}`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120_000);
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: image,
      signal: controller.signal
    })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success !== true) {
          throw new Error(
            response.status === 413
              ? "A imagem excede o limite permitido. Tire outra foto."
              : result.message || "O serviço de análise não conseguiu responder."
          );
        }
        return result;
      })
      .finally(() => window.clearTimeout(timeout));
  }

  async function analyzePhoto(image = photoBlob) {
    if (!image || analysisInProgress || image !== photoBlob) {
      return;
    }
    const generation = photoGeneration;
    analysisInProgress = true;
    lastAnalysisFailed = false;
    setFallback("");
    stopRecognizer();
    setState(STATES.ANALYZING, "Analisando a foto. Aguarde um instante.");
    try {
      const result = await requestJson(DESCRIPTION_URL, image);
      if (generation !== photoGeneration || image !== photoBlob) {
        return;
      }
      if (typeof result.description !== "string" || !result.description.trim()) {
        throw new Error("A análise terminou sem uma descrição.");
      }
      lastAnswer = result.description.trim();
      setFallback("");
      setState(STATES.WAITING_QUESTION, "Descrição pronta.");
      speak(
        `${lastAnswer} Você quer fazer alguma pergunta sobre essa foto?`,
        () => setRecognitionMode("question")
      );
    } catch (error) {
      if (generation !== photoGeneration || image !== photoBlob) {
        return;
      }
      const message =
        error.name === "AbortError"
          ? "A análise demorou demais e foi interrompida. Você pode tentar novamente."
          : error.message || "Não consegui analisar a foto. Você pode tentar novamente.";
      lastAnalysisFailed = true;
      setState(STATES.WAITING_QUESTION, message);
      setFallback(message, false, true);
      speak(message, () => {
        if (photoBlob === image) {
          setRecognitionMode("question");
        } else {
          setRecognitionMode("wake");
        }
      });
    } finally {
      analysisInProgress = false;
    }
  }

  async function askAboutPhoto(question) {
    const exactQuestion = question.trim();
    const image = photoBlob;
    const generation = photoGeneration;
    if (!image || !exactQuestion || questionInProgress || analysisInProgress) {
      return;
    }
    if (exactQuestion.length > 1_000) {
      speak(
        "A pergunta ficou longa demais. Tente fazer uma pergunta mais curta.",
        () => setRecognitionMode("question")
      );
      return;
    }

    questionInProgress = true;
    lastQuestion = exactQuestion;
    lastAnalysisFailed = false;
    stopRecognizer();
    setState(STATES.ANSWERING, "Enviando a pergunta junto com a mesma foto.");
    elements.questionForm.querySelector("button[type='submit']").disabled = true;
    questionController = new AbortController();
    const timeout = window.setTimeout(
      () => questionController?.abort(),
      120_000
    );
    try {
      const endpoint = `${QUESTION_URL}?question=${encodeURIComponent(exactQuestion)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": image.type },
        body: image,
        signal: questionController.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true || typeof result.answer !== "string") {
        throw new Error(
          response.status === 413
            ? "A imagem excede o limite permitido. Tire outra foto."
            : result.message || "Não consegui responder à pergunta. Tente novamente."
        );
      }
      if (generation !== photoGeneration || image !== photoBlob) {
        return;
      }
      lastAnswer = result.answer.trim();
      setState(STATES.WAITING_QUESTION, "Resposta pronta.");
      speak(
        `${lastAnswer} Você quer fazer outra pergunta sobre essa foto?`,
        () => setRecognitionMode("question")
      );
    } catch (error) {
      if (generation !== photoGeneration || image !== photoBlob) {
        return;
      }
      const message =
        error.name === "AbortError"
          ? "A resposta demorou demais. Você pode repetir a pergunta."
          : error.message || "Falha de conexão ao enviar a pergunta.";
      setState(STATES.WAITING_QUESTION, message);
      setFallback(message, false, true);
      speak(message, () => setRecognitionMode("question"));
    } finally {
      window.clearTimeout(timeout);
      questionController = null;
      questionInProgress = false;
      elements.questionForm.querySelector("button[type='submit']").disabled = false;
    }
  }

  function finishPhotoConversation() {
    stopRecognizer();
    releasePhoto();
    setState(STATES.RETURNING, "Encerrando esta conversa e voltando ao modo de espera.");
    speak("Tudo bem. Obrigado por conversar comigo. Estou voltando a aguardar Olá, Olhos.", () => {
      setState(STATES.WAITING_WAKE);
      setRecognitionMode("wake");
    });
  }

  function handleQuestionTurn(transcript) {
    const command = normalizeCommand(transcript);
    if (/(^|\s)(tente novamente|tentar novamente|repita|repetir)(\s|$)/.test(command)) {
      if (lastAnalysisFailed) {
        analyzePhoto();
      } else if (lastQuestion) {
        askAboutPhoto(lastQuestion);
      } else {
        analyzePhoto();
      }
      return;
    }
    if (
      /^(nao|nao quero|nao obrigado|nao obrigada|pode terminar|terminar|encerrar|chega)$/.test(
        command
      )
    ) {
      finishPhotoConversation();
      return;
    }
    if (requestContainsPhoto(command) && /(outra|nova|mais uma)/.test(command)) {
      beginPhotoFlow();
      return;
    }
    if (
      assistantState === STATES.CAMERA_ERROR &&
      /(tente novamente|tentar novamente|repetir|abrir a camera)/.test(command)
    ) {
      beginPhotoFlow();
      return;
    }
    if (!photoBlob) {
      speak(
        "Não tenho uma foto disponível. Diga “Olá, Olhos, tirar foto” para começar.",
        () => setRecognitionMode("wake")
      );
      return;
    }
    const exactQuestion = containsWakePhrase(command)
      ? removeWakePhraseFromTranscript(transcript)
      : transcript;
    askAboutPhoto(exactQuestion);
  }

  function beginPhotoFlow() {
    if (
      cameraOpening ||
      captureInProgress ||
      analysisInProgress ||
      questionInProgress ||
      assistantState === STATES.ORIENTING_PHOTO ||
      assistantState === STATES.WAITING_CAPTURE
    ) {
      return;
    }
    releasePhoto();
    setState(STATES.ORIENTING_PHOTO);
    speak(
      "Certo! Aponte o celular para aquilo que você deseja que eu descreva. Quando estiver pronto, diga: “Olá, Olhos, tirar foto”.",
      async () => {
        try {
          const ready = await openCamera();
          if (!ready) {
            return;
          }
          setState(
            STATES.WAITING_CAPTURE,
            "Câmera pronta. Aguardando “Olá, Olhos, tirar foto” ou “tirar foto”."
          );
          speak(
            "A câmera está pronta. Quando quiser, diga “Olá, Olhos, tirar foto” ou apenas “tirar foto”. Não vou capturar até ouvir esse comando.",
            () => setRecognitionMode("capture")
          );
        } catch (error) {
          await handleCameraFailure(error);
        }
      }
    );
  }

  async function handleCameraFailure(error) {
    stopCamera();
    captureInProgress = false;
    setState(
      STATES.CAMERA_ERROR,
      error.message || "Não consegui abrir a câmera. Tente novamente ou escolha uma imagem."
    );
    setFallback(
      `${error.message || "Não consegui abrir a câmera."} Você pode tentar abrir a câmera novamente ou escolher uma foto.`
    );
    speak(
      `${error.message || "Não consegui abrir a câmera."} Tente novamente ou escolha uma foto.`,
      () => {
        if (voiceEnabled) {
          setRecognitionMode("command");
        }
      }
    );
  }

  function handleWakeCommand(command) {
    setState(STATES.GREETING);
    const greeting =
      "Olá! Sou o Olhos, seu assistente visual. Posso ajudar você a entender o que está ao seu redor.";
    speak(greeting, () => {
      if (command && requestContainsPhoto(command)) {
        beginPhotoFlow();
      } else {
        setState(STATES.GREETING, "Atendimento iniciado. Diga o que você precisa.");
        setRecognitionMode("command");
      }
    });
  }

  function handleCommandTurn(transcript) {
    const command = normalizeCommand(transcript);
    if (!command) {
      setRecognitionMode("command");
      return;
    }
    if (command === "cancelar" || command.startsWith("cancelar ")) {
      setState(STATES.RETURNING, "Ação cancelada. Voltando ao modo de espera.");
      stopCamera();
      releasePhoto();
      speak("Tudo bem. Cancelei. Estou aguardando Olá, Olhos.", () => {
        setState(STATES.WAITING_WAKE);
        setRecognitionMode("wake");
      });
      return;
    }
    if (requestContainsPhoto(command)) {
      beginPhotoFlow();
      return;
    }
    if (command.includes("ler") || command.includes("leia")) {
      if (photoBlob) {
        askAboutPhoto("Leia o texto visível nesta foto e informe se alguma parte não estiver legível.");
      } else {
        speak("Para ler um texto, diga “tirar foto” para eu mostrar como enquadrar e aguardar a captura.");
        beginPhotoFlow();
      }
      return;
    }
    if (
      command.includes("descreva") ||
      command.includes("o que tem") ||
      command.includes("o que aparece") ||
      command.includes("o que esta na foto")
    ) {
      if (photoBlob) {
        analyzePhoto(photoBlob);
      } else {
        beginPhotoFlow();
      }
      return;
    }
    if (command.includes("repita a resposta") || command.includes("repetir resposta")) {
      if (lastAnswer) {
        speak(`${lastAnswer} Você quer fazer alguma pergunta sobre essa foto?`, () =>
          setRecognitionMode(photoBlob ? "question" : "wake")
        );
      } else {
        speak("Ainda não tenho uma resposta para repetir.", () =>
          setRecognitionMode("command")
        );
      }
      return;
    }
    if (photoBlob) {
      askAboutPhoto(transcript);
      return;
    }
    speak(
      "Posso descrever uma foto ou responder uma pergunta sobre ela. Diga “tirar foto” para começar.",
      () => setRecognitionMode("command")
    );
  }

  function handleVoiceInput(transcript) {
    const command = normalizeCommand(transcript);
    if (assistantState === STATES.WAITING_WAKE) {
      const wakeCommand = getWakePrefixedCommand(transcript);
      if (wakeCommand !== null) {
        handleWakeCommand(wakeCommand);
      }
      return;
    }
    if (assistantState === STATES.WAITING_CAPTURE) {
      const wakeCommand = getWakePrefixedCommand(transcript);
      const captureCommand = wakeCommand === null ? command : wakeCommand;
      if (requestContainsPhoto(captureCommand)) {
        capturePhoto();
      } else if (captureCommand === "cancelar" || captureCommand.startsWith("cancelar ")) {
        cancelCapture();
      }
      return;
    }
    if (assistantState === STATES.WAITING_QUESTION) {
      handleQuestionTurn(transcript);
      return;
    }
    if (
      assistantState === STATES.GREETING ||
      assistantState === STATES.CAMERA_ERROR
    ) {
      const wakeCommand = getWakePrefixedCommand(transcript);
      handleCommandTurn(wakeCommand === null ? transcript : wakeCommand);
      return;
    }
    if (assistantState === STATES.PAUSED) {
      return;
    }
    if (assistantState === STATES.WAITING_CAPTURE && command) {
      return;
    }
  }

  function cancelCapture() {
    if (assistantState !== STATES.WAITING_CAPTURE || captureInProgress) {
      return;
    }
    stopCamera();
    setState(STATES.RETURNING, "Captura cancelada.");
    speak("Tudo bem. Não tirei a foto. Estou aguardando Olá, Olhos.", () => {
      setState(STATES.WAITING_WAKE);
      setRecognitionMode("wake");
    });
  }

  function handleSelectedFile(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    elements.photoFile.value = "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setFallback("Escolha uma imagem JPEG, PNG ou WebP.");
      return;
    }
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setFallback("A imagem deve ter conteúdo e não pode ultrapassar 8 MiB.");
      return;
    }
    stopCamera();
    releasePhoto();
    photoBlob = file;
    photoUrl = URL.createObjectURL(file);
    elements.photoPreview.src = photoUrl;
    elements.photoSection.hidden = false;
    setState(STATES.ANALYZING, "Imagem selecionada. Vou analisar o que aparece nela.");
    speak("Imagem selecionada. Vou analisar o que aparece nela.", () => analyzePhoto(file));
  }

  function askAboutPhotoFromText(question) {
    if (!photoBlob) {
      setFallback("Tire ou escolha uma foto antes de enviar uma pergunta.");
      elements.question.focus();
      return;
    }
    askAboutPhoto(question);
  }

  function retryCurrentRecognition() {
    if (!microphonePermissionGranted || !SpeechRecognition) {
      beginMicrophoneSetup();
      return;
    }
    ensureRecognizer();
    if (!voiceEnabled) {
      setVoiceEnabled(true, { startListening: false });
    }
    const mode = recognitionModeForState();
    speak("Vou tentar retomar a escuta.", () => setRecognitionMode(mode));
  }

  function retryCurrentImageRequest() {
    if (!photoBlob) {
      setFallback("Tire ou escolha uma foto antes de tentar novamente.");
      return;
    }
    setFallback("");
    if (lastAnalysisFailed) {
      analyzePhoto();
    } else if (lastQuestion) {
      askAboutPhoto(lastQuestion);
    } else {
      analyzePhoto();
    }
  }

  function onQuestionSubmit(event) {
    event.preventDefault();
    askAboutPhotoFromText(elements.question.value);
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      if (recognizer && (recognitionRunning || recognitionStarting)) {
        recognitionStopRequested = true;
        try {
          recognizer.stop();
        } catch (error) {
          if (error.name !== "InvalidStateError") {
            setFallback("A escuta foi pausada ao sair da página.");
          }
        }
      }
      return;
    }
    if (voiceEnabled && microphonePermissionGranted) {
      if (assistantState === STATES.WAITING_WAKE) {
        setRecognitionMode("wake");
      } else if (assistantState === STATES.WAITING_CAPTURE) {
        setRecognitionMode("capture");
      } else if (assistantState === STATES.WAITING_QUESTION) {
        setRecognitionMode("question");
      } else if (assistantState === STATES.GREETING) {
        setRecognitionMode("command");
      }
    }
  }

  function onVoiceToggle() {
    if (voiceEnabled) {
      voiceEnabled = false;
      storeVoicePreference(false);
      stopRecognizer();
      setState(STATES.PAUSED);
      elements.voiceState.textContent = "Escuta pausada. Toque em retomar para voltar a ouvir.";
      elements.voiceToggle.textContent = "Retomar escuta";
      elements.voiceToggle.setAttribute("aria-pressed", "false");
      speak("Escuta pausada. Toque em retomar para ativá-la novamente.");
      return;
    }
    if (!microphonePermissionGranted) {
      beginMicrophoneSetup();
      return;
    }
    ensureRecognizer();
    voiceEnabled = true;
    storeVoicePreference(true);
    elements.voiceToggle.textContent = "Pausar escuta";
    elements.voiceToggle.setAttribute("aria-pressed", "true");
    setState(STATES.WAITING_WAKE, "Retomando a escuta.");
    speak("Pronto. Estou aguardando Olá, Olhos.", () => setRecognitionMode("wake"));
  }

  function onCameraButton() {
    if (assistantState === STATES.WAITING_CAPTURE && cameraStream) {
      capturePhoto();
      return;
    }
    beginPhotoFlow();
  }

  function onCaptureButton() {
    if (assistantState === STATES.WAITING_CAPTURE) {
      capturePhoto();
    }
  }

  function onRetakePhoto() {
    beginPhotoFlow();
  }

  function onCloseCamera() {
    if (assistantState === STATES.WAITING_CAPTURE) {
      cancelCapture();
      return;
    }
    stopCamera();
    elements.cameraSection.hidden = true;
  }

  function onManualQuestionVoice() {
    if (!microphonePermissionGranted) {
      beginMicrophoneSetup();
      return;
    }
    if (!photoBlob) {
      speak("Primeiro, tire ou escolha uma foto.");
      return;
    }
    setState(STATES.WAITING_QUESTION);
    speak("Pode dizer sua pergunta sobre esta foto.", () => setRecognitionMode("question"));
  }

  function initializeRecognitionPreference() {
    voiceEnabled = false;
    microphonePermissionGranted = false;
    if (!SpeechRecognition) {
      elements.setupVoice.textContent = "Começar configuração";
      setFallback(
        "Este navegador não oferece reconhecimento de voz. Você pode tirar ou escolher uma foto e digitar sua pergunta."
      );
      setState(STATES.NEEDS_SETUP);
    } else {
      refreshPermissionState();
    }
  }

  elements.listenIntroduction.addEventListener("click", () => {
    introductionPlaybackActive = true;
    elements.introductionStatus.textContent = "Reproduzindo a apresentação.";
    speak(INTRODUCTION, () => {
      introductionPlaybackActive = false;
      elements.introductionStatus.textContent = "Apresentação concluída.";
    });
  });
  elements.setupVoice.addEventListener("click", beginMicrophoneSetup);
  elements.voiceToggle.addEventListener("click", onVoiceToggle);
  elements.openCamera.addEventListener("click", onCameraButton);
  elements.pauseSpeech.addEventListener("click", toggleSpeechPause);
  elements.stopSpeech.addEventListener("click", stopSpeechAndContinue);
  elements.cancelPhoto.addEventListener("click", cancelCapture);
  elements.capturePhoto.addEventListener("click", onCaptureButton);
  elements.closeCamera.addEventListener("click", onCloseCamera);
  elements.filePickerButton.addEventListener("click", () => elements.photoFile.click());
  elements.photoFile.addEventListener("change", handleSelectedFile);
  elements.questionForm.addEventListener("submit", onQuestionSubmit);
  elements.retakePhoto.addEventListener("click", onRetakePhoto);
  elements.listenAgain.addEventListener("click", onManualQuestionVoice);
  elements.retryVoice.addEventListener("click", retryCurrentRecognition);
  elements.retryAnalysis.addEventListener("click", retryCurrentImageRequest);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    voiceEnabled = false;
    desiredRecognitionMode = null;
    stopRecognizer();
    stopCamera();
    if (questionController) {
      questionController.abort();
    }
    speechToken += 1;
    speechContinuation = null;
    speechActive = false;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    releasePhoto();
  });

  initializeRecognitionPreference();
})();

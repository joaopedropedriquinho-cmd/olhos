(() => {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const AI_URL = "/api/ai/ask-image";
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const elements = {
    setupVoice: document.getElementById("setup-voice"),
    voiceToggle: document.getElementById("voice-toggle"),
    voiceState: document.getElementById("voice-state"),
    permissionStatus: document.getElementById("permission-status"),
    fallbackNotice: document.getElementById("fallback-notice"),
    fallbackMessage: document.getElementById("fallback-message"),
    retryVoice: document.getElementById("retry-voice"),
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
    voiceStatus: document.getElementById("voice-status"),
    requestPanel: document.getElementById("request-panel"),
    requestMessage: document.getElementById("request-message"),
    cancelRequest: document.getElementById("cancel-request")
  };

  const socket = typeof window.io === "function" ? window.io() : null;

  let cameraStream = null;
  let photoBlob = null;
  let photoUrl = null;
  let recognition = null;
  let recognitionPurpose = null;
  let voiceModeActive = false;
  let speechActive = false;
  let speechPaused = false;
  let setupInProgress = false;
  let microphonePermissionGranted = false;
  let requestInProgress = false;
  let requestController = null;
  let activeRequestId = null;
  let volunteerRequestInProgress = false;
  let lastQuestion = "";
  let lastAnswer = "";
  let pendingQuestion = "";
  let pendingPhotoAction = null;
  let captureOperation = 0;
  let captureTimer = null;
  let listeningRestartTimer = null;
  let speechToken = 0;
  let speechContinuation = null;

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setVoiceStatus(message) {
    elements.voiceStatus.textContent = message;
  }

  function setFallback(message, showRetry = false) {
    elements.fallbackNotice.hidden = !message;
    elements.fallbackMessage.textContent = message || "";
    elements.retryVoice.hidden = !showRetry;
  }

  function setVoiceModeState(active) {
    voiceModeActive = active;
    elements.voiceToggle.setAttribute("aria-pressed", String(active));
    elements.voiceToggle.textContent = active
      ? "Desativar assistente de voz"
      : "Ativar assistente de voz";
    elements.voiceState.textContent = active
      ? "Assistente ativo. A escuta ocorre somente nesta página enquanto ela estiver aberta."
      : "Assistente de voz desligado.";
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

  function stopRecognition() {
    if (listeningRestartTimer) {
      window.clearTimeout(listeningRestartTimer);
      listeningRestartTimer = null;
    }

    if (!recognition) {
      recognitionPurpose = null;
      return;
    }

    const activeRecognition = recognition;
    recognition = null;
    recognitionPurpose = null;
    try {
      activeRecognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        setStatus("Não consegui pausar a escuta. Você ainda pode usar os controles da página.");
      }
    }
  }

  function continueAfterSpeech(callback) {
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
    } else if (voiceModeActive) {
      startRecognition("wake");
    }
  }

  function speak(text, onEnd) {
    stopRecognition();
    if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") {
      speechActive = false;
      speechPaused = false;
      elements.pauseSpeech.hidden = true;
      elements.stopSpeech.hidden = true;
      setStatus("A leitura em voz alta não está disponível. Use os controles da página.");
      setFallback("A voz do navegador não está disponível; as respostas continuam visíveis na tela.");
      if (typeof onEnd === "function") {
        onEnd();
      }
      return false;
    }

    const synth = window.speechSynthesis;
    const token = ++speechToken;
    speechContinuation = null;
    speechActive = false;
    elements.stopSpeech.hidden = true;
    synth.cancel();
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    const brazilianVoice = synth
      .getVoices()
      .find((voice) => /^pt-BR$/i.test(voice.lang));
    if (brazilianVoice) {
      utterance.voice = brazilianVoice;
    }

    speechActive = true;
    speechPaused = false;
    speechContinuation = onEnd;
    elements.pauseSpeech.textContent = "Pausar fala";
    elements.pauseSpeech.hidden = false;
    elements.stopSpeech.hidden = false;
    if (voiceModeActive) {
      elements.voiceState.textContent = "Assistente ativo. Escuta pausada enquanto o Olhos fala.";
    }
    utterance.onend = () => {
      if (token === speechToken) {
        continueAfterSpeech(onEnd);
      }
    };
    utterance.onerror = () => {
      if (token === speechToken) {
        setStatus("Não consegui concluir a fala. Você pode continuar pelos controles.");
        continueAfterSpeech(onEnd);
      }
    };

    try {
      synth.speak(utterance);
      return true;
    } catch (error) {
      if (token === speechToken) {
        setStatus("A voz do navegador falhou. Use os controles da página.");
        continueAfterSpeech(onEnd);
      }
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
    } else if (voiceModeActive) {
      startRecognition("wake");
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
      setStatus("Retomando a resposta em voz alta.");
    } else {
      window.speechSynthesis.pause();
      speechPaused = true;
      elements.pauseSpeech.textContent = "Retomar fala";
      setStatus("Fala pausada. Toque em retomar ou interromper.");
    }
  }

  function speakIntroAndSetup() {
    const greeting =
      "Olá! Sou o Olhos. Posso identificar objetos, ler textos, responder perguntas sobre imagens e chamar um voluntário. A escuta por voz só fica ativa quando você pedir, e pode parar quando a página for fechada ou o navegador interromper o reconhecimento.";
    setStatus("Vou explicar e depois pedir as permissões, uma de cada vez.");
    speak(greeting, requestMicrophonePermission);
  }

  async function queryPermission(name) {
    if (!navigator.permissions?.query) {
      return "unknown";
    }
    try {
      const result = await navigator.permissions.query({ name });
      return result.state;
    } catch (error) {
      return "unknown";
    }
  }

  async function refreshPermissionStatus() {
    const [microphone, camera] = await Promise.all([
      queryPermission("microphone"),
      queryPermission("camera")
    ]);
    const labels = [];
    if (microphone !== "unknown") {
      labels.push(`Microfone: ${microphone === "granted" ? "permitido" : microphone === "denied" ? "negado" : "ainda não solicitado"}`);
    }
    if (camera !== "unknown") {
      labels.push(`Câmera: ${camera === "granted" ? "permitida" : camera === "denied" ? "negada" : "ainda não solicitada"}`);
    }
    elements.permissionStatus.textContent = labels.join(". ");
    if (microphone === "granted") {
      microphonePermissionGranted = true;
    } else if (microphone === "denied") {
      microphonePermissionGranted = false;
    }
    if (microphone === "granted" && camera === "granted" && SpeechRecognition) {
      elements.setupVoice.hidden = true;
      elements.voiceToggle.hidden = false;
    } else if (microphone === "granted" && SpeechRecognition) {
      elements.setupVoice.textContent = "Concluir configuração por voz";
    }
    return { microphone, camera };
  }

  async function requestMediaPermission(kind) {
    const permissionName = kind === "microphone" ? "microphone" : "camera";
    const state = await queryPermission(permissionName);
    if (state === "granted") {
      return { granted: true, message: kind === "microphone" ? "O acesso ao microfone já está permitido." : "O acesso à câmera já está permitido." };
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return { granted: false, message: "Este navegador não permite acessar a mídia diretamente. Você ainda pode escolher uma foto e digitar sua pergunta." };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(
        kind === "microphone" ? { audio: true, video: false } : { audio: false, video: true }
      );
      stream.getTracks().forEach((track) => track.stop());
      if (kind === "microphone") {
        microphonePermissionGranted = true;
      }
      return {
        granted: true,
        message: kind === "microphone"
          ? "Permissão do microfone confirmada. O áudio não fica gravado pelo Meus Olhos."
          : "Permissão da câmera confirmada. A câmera só será aberta quando você pedir uma foto."
      };
    } catch (error) {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (kind === "microphone") {
        microphonePermissionGranted = false;
      }
      const denied = error.name === "NotAllowedError" || error.name === "PermissionDeniedError";
      return {
        granted: false,
        message: denied
          ? `O acesso ao ${kind === "microphone" ? "microfone" : "câmera"} foi negado. Você pode habilitá-lo nas configurações do navegador.`
          : `Não consegui confirmar o acesso ao ${kind === "microphone" ? "microfone" : "câmera"}. Verifique o navegador e tente novamente.`
      };
    }
  }

  async function runVoiceSetup() {
    if (setupInProgress) {
      return;
    }
    setupInProgress = true;
    elements.setupVoice.disabled = true;
    setFallback("");

    if (!SpeechRecognition) {
      const message =
        "Este navegador não oferece reconhecimento de voz compatível. Você poderá tirar ou escolher uma foto e digitar a pergunta.";
      speak(
        `${message} Vou pedir acesso à câmera para permitir a captura de fotos.`,
        async () => {
          const camera = await requestMediaPermission("camera");
          elements.permissionStatus.textContent = camera.message;
          elements.setupVoice.disabled = false;
          elements.setupVoice.textContent = "Tentar configuração novamente";
          setFallback(`${message} ${camera.message}`);
          setStatus("O modo de voz não está disponível neste navegador.");
          speak(`${message} ${camera.message}`);
          setupInProgress = false;
          refreshPermissionStatus();
        }
      );
      return;
    }

    const microphoneIntro =
      "Primeiro, vou pedir acesso ao microfone. Ele é necessário para reconhecer seus comandos enquanto o assistente de voz estiver ativado. O reconhecimento é fornecido pelo navegador.";
    speak(microphoneIntro, async () => {
      const microphone = await requestMediaPermission("microphone");
      microphonePermissionGranted = microphone.granted;
      elements.permissionStatus.textContent = microphone.message;
      speak(microphone.message, async () => {
        const cameraIntro =
          "Agora vou pedir acesso à câmera, necessário para tirar fotos quando você solicitar. Você também poderá escolher uma imagem.";
        speak(cameraIntro, async () => {
          const camera = await requestMediaPermission("camera");
          elements.permissionStatus.textContent = `${microphone.message} ${camera.message}`;
          setupInProgress = false;
          elements.setupVoice.disabled = false;

          if (microphone.granted) {
            elements.setupVoice.hidden = true;
            elements.voiceToggle.hidden = false;
            elements.voiceToggle.focus();
            setStatus(
              camera.granted
                ? "Configuração concluída. O assistente ainda está desligado."
                : "Microfone confirmado. A câmera não está disponível; você pode escolher uma foto."
            );
            setFallback(
              camera.granted
                ? "Configuração pronta. Ative o assistente quando quiser começar a usar a palavra “Olá, Olhos”."
                : camera.message
            );
            speak(
              camera.granted
                ? "Configuração concluída. O assistente está desligado. Toque em ativar assistente de voz quando quiser começar."
                : `${camera.message} O assistente está desligado. Você pode ativá-lo ou escolher uma foto.`,
              undefined
            );
          } else {
            elements.setupVoice.textContent = "Tentar configuração novamente";
            setFallback(
              `${microphone.message} Para permitir, abra as configurações de privacidade do site no navegador. A seleção de imagem e as perguntas digitadas continuam disponíveis.`
            );
            setStatus("O assistente de voz não foi ativado.");
            speak(elements.fallbackMessage.textContent);
          }
          refreshPermissionStatus();
        });
      });
    });
  }

  function deactivateVoiceMode(message = "Assistente de voz desligado.") {
    setVoiceModeState(false);
    stopRecognition();
    if (captureTimer || pendingPhotoAction || cameraStream) {
      captureOperation += 1;
      if (captureTimer) {
        window.clearTimeout(captureTimer);
      }
      captureTimer = null;
      pendingPhotoAction = null;
      pendingQuestion = "";
      stopCamera();
      elements.cameraSection.hidden = true;
    }
    elements.cancelPhoto.hidden = true;
    if (message) {
      setStatus(message);
    }
    setVoiceStatus("");
  }

  function activateVoiceMode() {
    if (!SpeechRecognition) {
      const message =
        "O reconhecimento de voz não está disponível neste navegador. Você pode digitar suas perguntas.";
      setFallback(message);
      setStatus(message);
      speak(message);
      return;
    }
    if (!microphonePermissionGranted) {
      const message =
        "Para ativar a escuta, primeiro permita o microfone na configuração por voz.";
      setStatus(message);
      setFallback(message);
      elements.setupVoice.hidden = false;
      elements.voiceToggle.hidden = true;
      speak(message);
      return;
    }
    setVoiceModeState(true);
    setFallback("");
    setStatus("Assistente pronto. Diga “Olá, Olhos” para começar. A escuta será pausada durante as falas.");
    speak(
      "Assistente ativado. Enquanto esta página estiver aberta, diga Olá, Olhos para me chamar. A tela bloqueada pode interromper a escuta.",
      () => startRecognition("wake")
    );
  }

  function handleRecognitionFailure(error, purpose) {
    const messages = {
      "not-allowed": "O navegador não permitiu usar o microfone. Verifique as permissões do site e tente novamente.",
      "service-not-allowed": "O serviço de reconhecimento de fala não está disponível. Você pode digitar sua pergunta.",
      "audio-capture": "Não consegui acessar o microfone. Verifique se ele está conectado e permitido.",
      network: "O reconhecimento de fala foi interrompido por um problema de rede.",
      "no-speech": "Não ouvi fala desta vez."
    };
    const message = messages[error] || "O reconhecimento de fala foi interrompido.";
    setStatus(message);
    setVoiceStatus(message);

    if (["not-allowed", "service-not-allowed", "audio-capture", "network"].includes(error)) {
      const wasActive = voiceModeActive;
      if (error === "not-allowed" || error === "audio-capture") {
        microphonePermissionGranted = false;
        elements.setupVoice.hidden = false;
        elements.setupVoice.textContent = "Tentar configuração novamente";
        elements.voiceToggle.hidden = true;
      }
      deactivateVoiceMode();
      setFallback(`${message} Você pode tentar novamente ou usar os controles da página.`, true);
      if (error !== "network" || wasActive) {
        speak(message);
      }
      return;
    }

    if (purpose === "command" && !voiceModeActive) {
      elements.listenAgain.hidden = !photoBlob;
    }
  }

  function startRecognition(purpose) {
    if (!SpeechRecognition || speechActive || (purpose === "wake" && !voiceModeActive)) {
      return;
    }
    stopRecognition();

    const currentRecognition = new SpeechRecognition();
    recognition = currentRecognition;
    recognitionPurpose = purpose;
    currentRecognition.lang = "pt-BR";
    currentRecognition.continuous = false;
    currentRecognition.interimResults = false;
    currentRecognition.maxAlternatives = 1;

    currentRecognition.onstart = () => {
      if (recognition !== currentRecognition) {
        return;
      }
      if (purpose === "wake") {
        elements.voiceState.textContent =
          "Assistente ativo. Diga “Olá, Olhos” quando quiser falar comigo.";
        setVoiceStatus("Escuta ativa para detectar a palavra de ativação.");
      } else if (purpose === "photo-cancel") {
        setVoiceStatus("Você pode dizer cancelar para interromper a foto.");
      } else {
        setStatus("Estou ouvindo. Diga seu comando ou pergunta.");
        setVoiceStatus("Microfone ligado para uma fala.");
      }
    };

    currentRecognition.onresult = (event) => {
      if (recognition !== currentRecognition) {
        return;
      }
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (!transcript) {
        return;
      }
      const heardPurpose = recognitionPurpose;
      stopRecognition();
      setVoiceStatus("");
      if (heardPurpose === "photo-cancel") {
        if (/^(cancelar|nao|pare|parar)(\s|$)/.test(normalizeCommand(transcript))) {
          cancelPendingCapture();
          return;
        }
        return;
      }
      handleVoiceInput(transcript, heardPurpose);
    };

    currentRecognition.onerror = (event) => {
      if (recognition !== currentRecognition) {
        return;
      }
      handleRecognitionFailure(event.error, purpose);
    };

    currentRecognition.onend = () => {
      if (recognition !== currentRecognition) {
        return;
      }
      recognition = null;
      recognitionPurpose = null;
      setVoiceStatus("");

      if (purpose === "wake" && voiceModeActive && !speechActive) {
        elements.voiceState.textContent = "Escuta retomando após uma pausa do navegador.";
        listeningRestartTimer = window.setTimeout(() => {
          listeningRestartTimer = null;
          startRecognition("wake");
        }, 350);
      } else if (purpose === "command" && voiceModeActive && !speechActive) {
        listeningRestartTimer = window.setTimeout(() => {
          listeningRestartTimer = null;
          startRecognition("wake");
        }, 350);
      }
    };

    try {
      currentRecognition.start();
    } catch (error) {
      recognition = null;
      recognitionPurpose = null;
      const message =
        error.name === "NotAllowedError"
          ? "O navegador não permitiu usar o microfone. Confira as configurações do site."
          : "Não foi possível iniciar a escuta. Tente novamente pelo botão.";
      setStatus(message);
      setFallback(message, true);
      if (error.name === "NotAllowedError") {
        microphonePermissionGranted = false;
        elements.setupVoice.hidden = false;
        elements.setupVoice.textContent = "Tentar configuração novamente";
        elements.voiceToggle.hidden = true;
      }
      if (voiceModeActive || purpose === "wake") {
        deactivateVoiceMode();
      }
    }
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

  function handleVoiceInput(transcript, purpose) {
    const command = normalizeCommand(transcript);
    if (purpose === "wake") {
      if (/^(parar de ouvir|desativar assistente)$/.test(command)) {
        deactivateVoiceMode("Escuta desativada.");
        speak("Pronto. Parei de ouvir.");
        return;
      }
      if (!containsWakePhrase(command)) {
        return;
      }
      const followUp = removeWakePhrase(command);
      if (followUp) {
        speak("Olá! Estou aqui.", () => dispatchCommand(followUp));
      } else {
        speak("Olá! Estou aqui. Como posso ajudar?", () =>
          startRecognition("command")
        );
      }
      return;
    }

    dispatchCommand(command || transcript);
  }

  function hasAny(command, phrases) {
    return phrases.some((phrase) => command.includes(phrase));
  }

  function dispatchCommand(rawCommand) {
    const command = normalizeCommand(rawCommand);
    if (!command) {
      if (voiceModeActive) {
        startRecognition("wake");
      }
      return;
    }

    if (hasAny(command, ["parar de ouvir", "desativar assistente"])) {
      deactivateVoiceMode("Escuta desativada.");
      speak("Pronto. Parei de ouvir.");
      return;
    }

    if (command === "cancelar" || command.startsWith("cancelar ")) {
      cancelCurrentAction();
      return;
    }

    if (hasAny(command, ["preciso de um voluntario", "preciso de ajuda", "chame um voluntario", "quero falar com um voluntario"])) {
      createVolunteerRequest();
      return;
    }

    if (hasAny(command, ["repetir resposta", "repita a resposta", "repita resposta"])) {
      if (lastAnswer) {
        readAnswer(lastAnswer);
      } else {
        speak("Ainda não tenho uma resposta para repetir.", resumeVoiceListening);
      }
      return;
    }

    if (hasAny(command, ["repetir pergunta", "repita a pergunta"])) {
      if (lastQuestion) {
        speak(`Sua última pergunta foi: ${lastQuestion}`, resumeVoiceListening);
      } else {
        speak("Ainda não há uma pergunta anterior.", resumeVoiceListening);
      }
      return;
    }

    if (hasAny(command, ["pausar fala", "parar de falar", "interromper fala"])) {
      speak(
        "Durante a minha fala, o microfone fica pausado para não confundir as vozes. Use o botão pausar fala ou interromper fala.",
        resumeVoiceListening
      );
      return;
    }

    if (hasAny(command, ["tirar outra foto", "nova foto", "tire uma foto", "tirar foto", "fotografe"])) {
      beginCapture(null, "photo");
      return;
    }

    if (hasAny(command, ["o que tem na minha frente", "o que ha na minha frente", "descreva o ambiente"])) {
      beginCapture(
        "Descreva de forma clara o ambiente visível, os objetos principais e a posição relativa deles.",
        "analysis"
      );
      return;
    }

    if (hasAny(command, ["leia isso para mim", "o que esta escrito aqui", "leia o texto", "leia isso"])) {
      useCurrentImageOrCapture(
        "Leia todo o texto legível na imagem. Preserve a ordem e informe quando alguma parte estiver ilegível."
      );
      return;
    }

    if (hasAny(command, ["descreva essa foto", "descreva a foto", "o que tem nessa foto"])) {
      useCurrentImageOrCapture(
        "Descreva a imagem de forma clara e objetiva, incluindo os objetos importantes e sua posição."
      );
      return;
    }

    if (hasAny(command, ["abrir a foto", "ver a ultima foto", "abrir ultima foto"])) {
      if (photoBlob) {
        speak(
          "A última foto está disponível nesta página. Você pode pedir para eu descrevê-la, ler o texto ou fazer outra pergunta.",
          resumeVoiceListening
        );
      } else {
        speak("Ainda não há uma foto nesta página. Diga tire uma foto para começar.", resumeVoiceListening);
      }
      return;
    }

    if (hasAny(command, ["me explica melhor", "explique melhor", "detalhe melhor"])) {
      if (!lastAnswer || !photoBlob) {
        speak("Não tenho uma resposta anterior para explicar melhor. Faça uma pergunta sobre uma foto.", resumeVoiceListening);
      } else {
        submitQuestion(
          `Explique melhor e com mais detalhes a resposta anterior: ${lastAnswer.slice(0, 650)}. A pergunta original foi: ${lastQuestion.slice(0, 250)}`.slice(0, 1_000)
        );
      }
      return;
    }

    if (hasAny(command, ["faca uma pergunta para a ia", "fazer uma pergunta para a ia", "quero perguntar"])) {
      askForQuestion();
      return;
    }

    if (photoBlob) {
      submitQuestion(rawCommand);
    } else {
      pendingQuestion = rawCommand;
      beginCapture(rawCommand, "analysis");
    }
  }

  function useCurrentImageOrCapture(question) {
    if (photoBlob) {
      submitQuestion(question);
    } else {
      beginCapture(question, "analysis");
    }
  }

  function askForQuestion() {
    speak("Pode me dizer o que você quer saber.", () => startRecognition("command"));
  }

  function resumeVoiceListening() {
    if (voiceModeActive) {
      startRecognition("wake");
    }
  }

  function clearPhoto() {
    photoBlob = null;
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    elements.photoPreview.removeAttribute("src");
    elements.photoSection.hidden = true;
    elements.listenAgain.hidden = true;
    elements.question.value = "";
  }

  function showPhoto(blob, question = null) {
    stopCamera();
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
    photoBlob = blob;
    photoUrl = URL.createObjectURL(blob);
    elements.photoPreview.src = photoUrl;
    elements.photoPreview.focus();
    elements.photoSection.hidden = false;
    elements.cameraSection.hidden = true;
    elements.listenAgain.hidden = true;
    elements.question.value = question || "";
    elements.cancelPhoto.hidden = true;
    pendingPhotoAction = null;
    pendingQuestion = "";
    setStatus("Foto capturada. A imagem fica apenas nesta página.");

    if (question) {
      submitQuestion(question);
      return;
    }
    speak(
      voiceModeActive
        ? "Foto capturada. Diga Olá, Olhos para fazer uma pergunta, pedir uma descrição ou pedir que eu leia o texto."
        : "Foto capturada. Você pode digitar uma pergunta ou tocar em perguntar por voz.",
      () => {
        if (voiceModeActive) {
          startRecognition("wake");
        } else {
          elements.listenAgain.hidden = false;
        }
      }
    );
  }

  function openImagePicker() {
    elements.filePickerButton.hidden = false;
    elements.filePickerButton.focus();
  }

  async function openCamera({ interactive = true } = {}) {
    if (interactive && (captureTimer || pendingPhotoAction)) {
      captureOperation += 1;
      if (captureTimer) {
        window.clearTimeout(captureTimer);
        captureTimer = null;
      }
      pendingPhotoAction = null;
      elements.cancelPhoto.hidden = true;
    }
    stopRecognition();
    stopCamera();
    elements.cameraSection.hidden = false;
    elements.filePickerButton.hidden = false;
    if (interactive) {
      elements.photoFile.value = "";
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("A câmera direta não está disponível. Use a opção para tirar ou escolher uma foto.");
      setFallback("Você também pode selecionar uma imagem JPEG, PNG ou WebP.");
      openImagePicker();
      return false;
    }

    setStatus("Solicitando acesso à câmera.");
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } }
      });
      elements.cameraPreview.srcObject = cameraStream;
      elements.cameraPreview.hidden = false;
      elements.capturePhoto.hidden = false;
      elements.closeCamera.hidden = false;
      await elements.cameraPreview.play();
      setStatus("Câmera pronta.");
      return true;
    } catch (error) {
      stopCamera();
      const message =
        error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
          ? "O acesso à câmera foi negado. Habilite a câmera nas configurações do site ou escolha uma imagem."
          : "Não consegui abrir a câmera. Verifique a permissão ou escolha uma imagem.";
      setStatus(message);
      setFallback(message);
      openImagePicker();
      return false;
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

  async function captureFrame(question = null, operation = captureOperation) {
    const video = elements.cameraPreview;
    if (!cameraStream || !video.videoWidth || !video.videoHeight) {
      setStatus("A câmera ainda está sendo preparada. Tente novamente.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setStatus("Não consegui preparar a foto. Tente escolher uma imagem.");
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const blob = await canvasToJpeg(canvas, 0.95);
      if (blob.size > MAX_IMAGE_BYTES) {
        throw new Error("A foto ultrapassa 8 MiB. Tente novamente ou escolha uma imagem menor.");
      }
      if (operation !== captureOperation) {
        return;
      }
      showPhoto(blob, question);
    } catch (error) {
      setStatus(error.message || "Não foi possível preparar a foto.");
      setFallback("Tente tirar outra foto ou escolha uma imagem menor.");
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  async function beginCapture(question, action) {
    if (captureTimer) {
      window.clearTimeout(captureTimer);
      captureTimer = null;
    }
    const operation = ++captureOperation;
    pendingPhotoAction = { question, action, operation };
    pendingQuestion = question || "";
    const opened = cameraStream ? true : await openCamera({ interactive: false });
    if (operation !== captureOperation || !pendingPhotoAction) {
      stopCamera();
      return;
    }
    if (!opened) {
      pendingQuestion = question || "";
      speak(
        "Não consegui abrir a câmera. Use o botão para tirar ou escolher uma foto.",
        resumeVoiceListening
      );
      return;
    }

    elements.cancelPhoto.hidden = false;
    elements.closeCamera.hidden = true;
    speak(
      "Vou tirar a foto em alguns segundos. Diga cancelar se quiser interromper.",
      () => {
        if (voiceModeActive || microphonePermissionGranted) {
          startRecognition("photo-cancel");
        }
        captureTimer = window.setTimeout(() => {
          captureTimer = null;
          elements.cancelPhoto.hidden = true;
          stopRecognition();
          const pending = pendingPhotoAction;
          if (pending?.operation === operation && operation === captureOperation) {
            captureFrame(
              pending.action === "analysis" ? pending.question : null,
              operation
            );
          }
        }, 5_000);
      }
    );
  }

  function cancelPendingCapture() {
    captureOperation += 1;
    if (captureTimer) {
      window.clearTimeout(captureTimer);
      captureTimer = null;
    }
    pendingPhotoAction = null;
    pendingQuestion = "";
    elements.cancelPhoto.hidden = true;
    stopCamera();
    elements.cameraSection.hidden = true;
    setStatus("Foto cancelada.");
    speak("Foto cancelada.", resumeVoiceListening);
  }

  function closeCamera() {
    stopCamera();
    elements.cameraSection.hidden = true;
    setStatus("Câmera fechada.");
    if (voiceModeActive) {
      speak("Câmera fechada.", resumeVoiceListening);
    }
  }

  function cancelCurrentAction() {
    if (pendingPhotoAction || captureTimer) {
      cancelPendingCapture();
      return;
    }
    if (requestInProgress && requestController) {
      requestController.abort();
      requestController = null;
      requestInProgress = false;
      elements.questionForm.querySelector("button[type='submit']").disabled = false;
      setStatus("Pergunta cancelada.");
      speak("Tudo bem. Cancelei a pergunta.", resumeVoiceListening);
      return;
    }
    if (volunteerRequestInProgress) {
      speak("O pedido ainda está sendo enviado. Aguarde a confirmação antes de cancelar.", resumeVoiceListening);
      return;
    }
    if (activeRequestId) {
      cancelVolunteerRequest();
      return;
    }
    if (speechActive) {
      stopSpeechAndContinue();
      setStatus("Fala interrompida.");
      return;
    }
    speak("Não há nenhuma ação em andamento para cancelar.", resumeVoiceListening);
  }

  function handleSelectedFile(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setStatus("Escolha uma imagem JPEG, PNG ou WebP.");
      event.target.value = "";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus("A imagem ultrapassa o limite de 8 MiB. Escolha uma imagem menor.");
      event.target.value = "";
      return;
    }
    const question = pendingQuestion || pendingPhotoAction?.question || null;
    captureOperation += 1;
    pendingQuestion = "";
    pendingPhotoAction = null;
    showPhoto(file, question);
  }

  async function submitQuestion(question) {
    const cleanQuestion = question.trim();
    if (!photoBlob) {
      pendingQuestion = cleanQuestion;
      beginCapture(cleanQuestion, "analysis");
      return;
    }
    if (!cleanQuestion) {
      setStatus("Diga ou digite uma pergunta sobre a foto.");
      elements.question.focus();
      return;
    }
    if (cleanQuestion.length > 1_000) {
      const message = "A pergunta ficou longa demais. Tente resumi-la e perguntar novamente.";
      setStatus(message);
      speak(message, resumeVoiceListening);
      return;
    }
    if (requestInProgress) {
      return;
    }

    lastQuestion = cleanQuestion;
    stopRecognition();
    requestController = new AbortController();
    requestInProgress = true;
    elements.listenAgain.hidden = true;
    elements.question.value = cleanQuestion;
    elements.questionForm.querySelector("button[type='submit']").disabled = true;
    setStatus("Enviando sua pergunta e a imagem. Aguarde a resposta.");

    try {
      const endpoint = `${AI_URL}?question=${encodeURIComponent(cleanQuestion)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": photoBlob.type },
        body: photoBlob,
        signal: requestController.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true || typeof result.answer !== "string") {
        throw new Error(
          response.status === 413
            ? "A imagem ultrapassa o limite aceito. Tire outra foto ou escolha uma imagem menor."
            : "Não foi possível obter uma resposta agora. Verifique a conexão e tente novamente."
        );
      }

      lastAnswer = result.answer;
      setStatus("Resposta recebida.");
      readAnswer(result.answer);
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      const message =
        error instanceof TypeError
          ? "Falha de rede ao enviar a imagem. Verifique sua conexão e tente novamente."
          : error.message || "O serviço de IA falhou. Tente novamente.";
      setStatus(message);
      elements.listenAgain.hidden = false;
      speak(message, resumeVoiceListening);
    } finally {
      requestController = null;
      requestInProgress = false;
      elements.questionForm.querySelector("button[type='submit']").disabled = false;
    }
  }

  function readAnswer(answer) {
    setStatus("Resposta pronta. Vou ler para você.");
    const nextStep = voiceModeActive
      ? "Para continuar, diga Olá, Olhos."
      : "Para continuar por voz, toque em perguntar por voz.";
    speak(
      `${answer} ${nextStep} Você também pode repetir a resposta, repetir a pergunta, tirar outra foto ou pedir um voluntário.`,
      () => {
        if (voiceModeActive) {
          startRecognition("wake");
        } else {
          elements.listenAgain.hidden = false;
        }
      }
    );
  }

  async function createVolunteerRequest() {
    stopRecognition();
    stopCamera();
    if (activeRequestId || volunteerRequestInProgress) {
      speak("Seu pedido de ajuda já está aguardando resposta.", resumeVoiceListening);
      return;
    }
    if (!socket?.connected) {
      const message =
        "Não consegui conectar aos voluntários. Verifique sua conexão e tente novamente.";
      setStatus(message);
      speak(message, resumeVoiceListening);
      return;
    }

    volunteerRequestInProgress = true;
    elements.requestPanel.hidden = false;
    elements.requestMessage.textContent = "Enviando pedido de ajuda.";
    elements.cancelRequest.hidden = true;
    setStatus("Enviando seu pedido de ajuda.");
    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userName: "Pessoa usuária",
          type: "visual_assistance",
          socketId: socket.id
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.request?.id) {
        throw new Error("Não foi possível registrar seu pedido de ajuda.");
      }

      activeRequestId = result.request.id;
      elements.requestMessage.textContent =
        "Pedido enviado. Aguardando confirmação de um voluntário.";
      elements.cancelRequest.hidden = false;
      setStatus("Seu pedido foi enviado. Aguardando confirmação de um voluntário.");
      speak(
        "Seu pedido foi enviado. Estou aguardando a confirmação de um voluntário.",
        resumeVoiceListening
      );
    } catch (error) {
      elements.requestMessage.textContent = error.message;
      setStatus(error.message);
      speak(error.message, resumeVoiceListening);
    } finally {
      volunteerRequestInProgress = false;
    }
  }

  async function cancelVolunteerRequest() {
    if (!activeRequestId) {
      return;
    }
    elements.cancelRequest.disabled = true;
    try {
      const response = await fetch(
        `/api/requests/${encodeURIComponent(activeRequestId)}/cancel`,
        { method: "POST" }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Não foi possível cancelar o pedido.");
      }
      activeRequestId = null;
      elements.requestMessage.textContent = "Pedido cancelado.";
      elements.cancelRequest.hidden = true;
      setStatus("Pedido de ajuda cancelado.");
      speak("Seu pedido foi cancelado.", resumeVoiceListening);
    } catch (error) {
      setStatus(error.message);
      elements.requestMessage.textContent = error.message;
      speak(error.message, resumeVoiceListening);
    } finally {
      elements.cancelRequest.disabled = false;
    }
  }

  function onVolunteerAccepted(request) {
    if (request.id !== activeRequestId) {
      return;
    }
    activeRequestId = null;
    const volunteer = request.volunteerName || "Um voluntário";
    elements.requestMessage.textContent = `${volunteer} aceitou seu pedido.`;
    elements.cancelRequest.hidden = true;
    setStatus(`${volunteer} aceitou seu pedido de ajuda.`);
    speak(`${volunteer} aceitou seu pedido de ajuda.`, resumeVoiceListening);
  }

  function onVolunteerCancelled(request) {
    if (request.id !== activeRequestId) {
      return;
    }
    activeRequestId = null;
    elements.requestMessage.textContent = "O pedido foi cancelado.";
    elements.cancelRequest.hidden = true;
    setStatus("O pedido foi cancelado.");
    speak("O pedido foi cancelado.", resumeVoiceListening);
  }

  elements.setupVoice.addEventListener("click", runVoiceSetup);
  elements.voiceToggle.addEventListener("click", () => {
    if (voiceModeActive) {
      deactivateVoiceMode("Escuta desativada.");
      speak("Escuta desativada.");
    } else {
      activateVoiceMode();
    }
  });
  elements.openCamera.addEventListener("click", async () => {
    const opened = await openCamera();
    if (opened) {
      elements.capturePhoto.focus();
      speak(
        "Câmera pronta. Você pode tocar em tirar foto ou, se o assistente estiver ativado, dizer Olá, Olhos e pedir uma foto.",
        () => {
          if (voiceModeActive) {
            startRecognition("wake");
          }
        }
      );
    }
  });
  elements.stopSpeech.addEventListener("click", stopSpeechAndContinue);
  elements.pauseSpeech.addEventListener("click", toggleSpeechPause);
  elements.cancelPhoto.addEventListener("click", cancelPendingCapture);
  elements.closeCamera.addEventListener("click", closeCamera);
  elements.capturePhoto.addEventListener("click", () => {
    const captureQuestion =
      pendingPhotoAction?.action === "analysis"
        ? pendingPhotoAction.question
        : pendingQuestion || null;
    if (captureTimer) {
      window.clearTimeout(captureTimer);
      captureTimer = null;
      elements.cancelPhoto.hidden = true;
    }
    stopRecognition();
    captureOperation += 1;
    captureFrame(captureQuestion, captureOperation);
  });
  elements.filePickerButton.addEventListener("click", () => elements.photoFile.click());
  elements.photoFile.addEventListener("change", handleSelectedFile);
  elements.retakePhoto.addEventListener("click", () => beginCapture(null, "photo"));
  elements.listenAgain.addEventListener("click", () => {
    if (microphonePermissionGranted) {
      startRecognition("command");
    } else {
      setStatus("Configure o microfone antes de usar perguntas por voz.");
      elements.setupVoice.focus();
      speak("Configure o microfone antes de usar perguntas por voz.");
    }
  });
  elements.retryVoice.addEventListener("click", activateVoiceMode);
  elements.questionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitQuestion(elements.question.value);
  });
  elements.cancelRequest.addEventListener("click", cancelVolunteerRequest);

  if (socket) {
    socket.on("request_accepted", onVolunteerAccepted);
    socket.on("request_cancelled", onVolunteerCancelled);
    socket.on("disconnect", () => {
      if (activeRequestId) {
        setStatus("A conexão com os voluntários foi interrompida. Ainda não há confirmação.");
      }
    });
  }

  window.addEventListener("pagehide", () => {
    deactivateVoiceMode("");
    stopCamera();
    if (requestController) {
      requestController.abort();
    }
    if (captureTimer) {
      window.clearTimeout(captureTimer);
    }
    speechToken += 1;
    speechContinuation = null;
    speechActive = false;
    speechPaused = false;
    elements.pauseSpeech.hidden = true;
    elements.stopSpeech.hidden = true;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
  });

  refreshPermissionStatus();
})();

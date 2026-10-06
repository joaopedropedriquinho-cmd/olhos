const socket = io({ auth: { role: "user" } });
const nameInput = document.querySelector("#user-name");
const helpButton = document.querySelector("#help-button");
const listenButton = document.querySelector("#listen-button");
const welcomeButton = document.querySelector("#welcome-button");
const visionButton = document.querySelector("#vision-button");
const setupButton = document.querySelector("#setup-button");
const permissionStatus = document.querySelector("#permission-status");
const statusPanel = document.querySelector("#request-status");
const statusMessage = document.querySelector("#status-message");
const requestDetails = document.querySelector("#request-details");
const cancelButton = document.querySelector("#cancel-button");
const consentActions = document.querySelector("#consent-actions");
const consentYesButton = document.querySelector("#consent-yes");
const consentNoButton = document.querySelector("#consent-no");
const connectionStatus = document.querySelector("#connection-status");
const voiceStatus = document.querySelector("#voice-status");
const cameraPreview = document.querySelector("#camera-preview");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
let activeRequestId = null;
let listening = false;
let visionConsentPending = false;
let volunteerConsentPending = false;
let connectedBefore = false;

if (recognition) {
  recognition.lang = "pt-BR";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.addEventListener("start", () => {
    listening = true;
    listenButton.setAttribute("aria-pressed", "true");
    listenButton.textContent = "PARAR DE OUVIR";
    setVoiceStatus("Estou ouvindo. Pode falar agora.");
  });

  recognition.addEventListener("result", (event) => {
    const transcript = event.results[event.resultIndex][0].transcript.trim();
    setVoiceStatus(`Você disse: ${transcript}`);
    handleVoiceCommand(transcript);
  });

  recognition.addEventListener("error", (event) => {
    listening = false;
    const message =
      event.error === "not-allowed"
        ? "O acesso ao microfone foi negado. Permita o microfone nas configurações do navegador ou use o botão Preciso de ajuda."
        : event.error === "no-speech"
          ? "Não ouvi uma fala. Toque em Falar agora e tente novamente."
          : "O reconhecimento de voz não está disponível no momento. Você ainda pode usar os botões.";
    announce(message);
  });

  recognition.addEventListener("end", () => {
    listening = false;
    listenButton.setAttribute("aria-pressed", "false");
    listenButton.textContent = "🎤 FALAR AGORA";
  });
}

socket.on("connect", () => {
  connectionStatus.textContent = "Conectado ao serviço.";
  if (connectedBefore) {
    announce("A conexão com o serviço foi restabelecida.");
  }
  connectedBefore = true;
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Conexão interrompida. Tentando reconectar…";
  announce("A conexão foi interrompida. Tentando reconectar.");
});

socket.on("request_accepted", (request) => {
  if (request.id !== activeRequestId) {
    return;
  }
  activeRequestId = null;
  cancelButton.hidden = true;
  showStatus(
    "🙋 Um voluntário aceitou ajudar você.",
    `Seu pedido foi aceito por ${request.volunteerName}.`
  );
  helpButton.disabled = false;
  announce(`Um voluntário aceitou ajudar você. ${request.volunteerName} aceitou seu pedido.`);
});

socket.on("request_cancelled", (request) => {
  if (request.id !== activeRequestId) {
    return;
  }
  activeRequestId = null;
  showStatus("Pedido cancelado.", "Se precisar, você pode fazer um novo pedido.");
  cancelButton.hidden = true;
  helpButton.disabled = false;
  announce("Seu pedido foi cancelado.");
});

setupButton.addEventListener("click", configurePermissions);
listenButton.addEventListener("click", () => {
  if (listening) {
    recognition.stop();
    setVoiceStatus("Escuta encerrada.");
    speak("Escuta encerrada.");
    return;
  }

  startListening();
});
welcomeButton.addEventListener("click", () => {
  speak(
    "Olá! Eu sou o Meus Olhos. Posso conectar você a um voluntário. " +
      "Diga: preciso de ajuda, o que está na minha frente, leia isso para mim, ou cancelar."
  );
});
helpButton.addEventListener("click", () => createHelpRequest());
visionButton.addEventListener("click", requestVisionConsent);
cancelButton.addEventListener("click", cancelHelpRequest);
consentYesButton.addEventListener("click", () => handleConsent(true));
consentNoButton.addEventListener("click", () => handleConsent(false));

window.addEventListener("load", () => {
  speak(
    "Olá! Eu sou o Meus Olhos. Você pode falar comigo. Diga: preciso de ajuda, " +
      "o que está na minha frente, ou leia isso para mim. A descrição de imagens " +
      "por inteligência artificial ainda não está disponível."
  );
});

async function configurePermissions() {
  setupButton.disabled = true;
  const results = [];

  if ("Notification" in window && Notification.permission === "default") {
    try {
      const permissionPromise = Notification.requestPermission();
      const result = await permissionPromise;
      results.push(
        result === "granted"
          ? "notificações permitidas"
          : "notificações não permitidas; são opcionais"
      );
    } catch {
      results.push("não foi possível configurar notificações; são opcionais");
    }
  } else if ("Notification" in window && Notification.permission === "granted") {
    results.push("notificações já permitidas");
  } else {
    results.push("notificações não disponíveis ou bloqueadas; são opcionais");
  }

  results.push(await requestAndReleaseMedia("microfone", { audio: true }));
  results.push(await requestAndReleaseMedia("câmera", { video: true }));

  const summary = `Configuração concluída. ${results.join(". ")}. ` +
    "A câmera só será acessada quando você pedir ajuda com uma imagem.";
  permissionStatus.textContent = summary;
  setupButton.disabled = false;

  if (recognition && results.some((result) => result.includes("microfone concedida"))) {
    speak(
      `${summary} Olá! Como posso ajudar? Toque em Falar agora e diga seu pedido.`
    );
  } else {
    announce(summary);
  }
}

async function requestAndReleaseMedia(label, constraints) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return `${label} não disponível neste navegador`;
  }

  const deviceName = label === "câmera" ? "A câmera" : "O microfone";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    return `Permissão para ${label === "câmera" ? "a câmera" : "o microfone"} concedida`;
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return `acesso ${label === "câmera" ? "à câmera" : "ao microfone"} negado; você ainda pode usar as outras funções`;
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return `${deviceName} não encontrado${label === "câmera" ? "a" : ""} neste dispositivo`;
    }
    return `não foi possível acessar ${label === "câmera" ? "a câmera" : "o microfone"}`;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

function startListening() {
  if (!recognition) {
    announce(
      "O reconhecimento de fala não é compatível com este navegador. " +
        "Use o botão Preciso de ajuda ou abra esta página em um navegador compatível."
    );
    return;
  }

  if (!window.isSecureContext) {
    announce("O microfone exige uma conexão segura ou localhost. Abra o aplicativo por HTTPS.");
    return;
  }

  const beginRecognition = () => {
    try {
      recognition.start();
    } catch (error) {
      if (error.name === "InvalidStateError") {
        announce("Já estou ouvindo. Pode falar agora.");
        return;
      }
      announce("Não foi possível iniciar o reconhecimento de voz. Verifique a permissão do microfone.");
    }
  };

  if ("speechSynthesis" in window) {
    speak("Pode falar agora.", beginRecognition);
  } else {
    beginRecognition();
  }
}

async function handleVoiceCommand(transcript) {
  const command = normalize(transcript);

  if (visionConsentPending) {
    if (isYes(command)) {
      await handleConsent(true);
    } else if (isNo(command) || isCancel(command)) {
      await handleConsent(false);
    } else {
      respond("Responda sim para continuar ou não para cancelar.");
    }
    return;
  }

  if (volunteerConsentPending) {
    if (isYes(command)) {
      await handleConsent(true);
    } else if (isNo(command) || isCancel(command)) {
      await handleConsent(false);
    } else {
      respond("Responda sim para chamar um voluntário ou não para continuar sem atendimento.");
    }
    return;
  }

  if (isCancel(command)) {
    if (activeRequestId) {
      await cancelHelpRequest();
    } else {
      respond("Não há um pedido ativo para cancelar.");
    }
    return;
  }

  if (isDecisionVisionRequest(command)) {
    visionConsentPending = false;
    volunteerConsentPending = false;
    askForVolunteer(
      "A inteligência artificial de visão não está configurada e não posso avaliar " +
        "se uma situação é segura. Não atravesse uma rua nem enfrente um risco com base " +
        "nesta aplicação. Posso chamar um voluntário?"
    );
    return;
  }

  if (isHelpRequest(command) || isVolunteerRequest(command)) {
    await createHelpRequest();
    return;
  }

  if (isVisionRequest(command)) {
    requestVisionConsent();
    return;
  }

  respond("Não entendi o pedido. Diga preciso de ajuda, descreva a imagem ou cancelar.");
}

async function captureAndDescribe() {
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    askForVolunteer(
      "A câmera não está disponível nesta conexão. Posso chamar um voluntário?"
    );
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    cameraPreview.srcObject = stream;
    await cameraPreview.play();
    if (!cameraPreview.videoWidth || !cameraPreview.videoHeight) {
      await new Promise((resolve, reject) => {
        cameraPreview.addEventListener("loadedmetadata", resolve, { once: true });
        cameraPreview.addEventListener("error", reject, { once: true });
      });
    }

    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1280 / cameraPreview.videoWidth);
    canvas.width = Math.round(cameraPreview.videoWidth * scale);
    canvas.height = Math.round(cameraPreview.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Não foi possível preparar a imagem capturada.");
    }
    context.drawImage(cameraPreview, 0, 0, canvas.width, canvas.height);
    const imageDataUrl = canvas.toDataURL("image/jpeg", 0.75);
    stream.getTracks().forEach((track) => track.stop());
    cameraPreview.srcObject = null;

    const response = await fetch("/api/assistant/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Não foi possível processar a solicitação de imagem.");
    }
    askForVolunteer(result.spokenResponse);
  } catch (error) {
    const permissionDenied =
      error.name === "NotAllowedError" || error.name === "PermissionDeniedError";
    askForVolunteer(
      permissionDenied
        ? "O acesso à câmera foi negado. Posso chamar um voluntário para ajudar?"
        : "Não foi possível capturar a imagem. Posso chamar um voluntário para ajudar?"
    );
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    cameraPreview.srcObject = null;
  }
}

function requestVisionConsent() {
  visionConsentPending = true;
  volunteerConsentPending = false;
  consentActions.hidden = false;
  respond(
    "Ainda não há inteligência artificial de visão configurada e não consigo identificar " +
      "uma imagem com segurança. Se você autorizar, posso capturar uma foto e enviá-la " +
      "temporariamente ao servidor para o fluxo de demonstração. Ela não será guardada. " +
      "Deseja continuar? Diga sim ou não."
  );
}

function askForVolunteer(message) {
  visionConsentPending = false;
  volunteerConsentPending = true;
  consentActions.hidden = false;
  respond(`${message} Diga sim para chamar ou não para cancelar.`);
}

async function handleConsent(accepted) {
  if (visionConsentPending) {
    visionConsentPending = false;
    consentActions.hidden = true;
    if (accepted) {
      await captureAndDescribe();
    } else {
      respond("Tudo bem. Não vou capturar nem enviar nenhuma imagem.");
    }
    return;
  }

  if (volunteerConsentPending) {
    volunteerConsentPending = false;
    consentActions.hidden = true;
    if (accepted) {
      await createHelpRequest();
    } else {
      respond("Tudo bem. Não vou chamar um voluntário. Você pode pedir ajuda quando quiser.");
    }
  }
}

async function createHelpRequest() {
  if (activeRequestId) {
    respond("Seu pedido já está procurando um voluntário.");
    return;
  }

  visionConsentPending = false;
  volunteerConsentPending = false;
  consentActions.hidden = true;
  helpButton.disabled = true;
  showStatus("Enviando seu pedido…", "");

  try {
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userName: nameInput.value.trim() || "Pessoa usuária",
        type: "visual_assistance",
        socketId: socket.id
      })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Não foi possível enviar o pedido.");
    }

    activeRequestId = result.request.id;
    showStatus("Procurando um voluntário…", "Avisaremos você assim que alguém aceitar.");
    cancelButton.hidden = false;
    respond("Seu pedido foi enviado. Estou procurando um voluntário.");
  } catch (error) {
    showStatus("Não foi possível enviar o pedido.", error.message);
    helpButton.disabled = false;
    respond(`Não foi possível enviar o pedido. ${error.message}`);
  }
}

async function cancelHelpRequest() {
  if (!activeRequestId) {
    respond("Não há um pedido ativo para cancelar.");
    return;
  }

  cancelButton.disabled = true;
  try {
    const requestId = activeRequestId;
    const response = await fetch(`/api/requests/${encodeURIComponent(activeRequestId)}/cancel`, {
      method: "POST"
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Não foi possível cancelar o pedido.");
    }
    if (activeRequestId === requestId) {
      activeRequestId = null;
      showStatus("Pedido cancelado.", "Se precisar, você pode fazer um novo pedido.");
      cancelButton.hidden = true;
      helpButton.disabled = false;
      respond("Seu pedido foi cancelado.");
    }
  } catch (error) {
    requestDetails.textContent = error.message;
    respond(error.message);
  } finally {
    cancelButton.disabled = false;
  }
}

function isHelpRequest(command) {
  return /\b(preciso de ajuda|quero ajuda|me ajude|ajude me|chame ajuda)\b/.test(command);
}

function isVolunteerRequest(command) {
  return /\b(quero falar com um voluntario|falar com voluntario|chame um voluntario|chamar um voluntario)\b/.test(command);
}

function isVisionRequest(command) {
  return /\b(na minha frente|(?:quero saber )?o que (tem|esta) (aqui|na minha frente)|descreva|descreve|o que estou vendo|o que eu estou vendo|leia isso|ler isso|leia para mim|ler para mim|leia o texto|analise a imagem|analisa a imagem)\b/.test(command);
}

function isDecisionVisionRequest(command) {
  return /\b(quero saber se preciso de ajuda|nao tenho certeza se consigo atravessar|posso atravessar|devo atravessar|isso e seguro|e seguro atravessar)\b/.test(command);
}

function isCancel(command) {
  return /\b(cancelar|cancele|cancela|desistir|desisto)\b/.test(command);
}

function isYes(command) {
  return /^(sim|sim por favor|pode|pode sim|quero|claro|isso)$/.test(command);
}

function isNo(command) {
  return /^(nao|nao obrigado|nao obrigada|agora nao|cancela|deixa)$/.test(command);
}

function normalize(text) {
  return text
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function showStatus(message, details) {
  statusPanel.hidden = false;
  statusMessage.textContent = message;
  requestDetails.textContent = details;
}

function setVoiceStatus(message) {
  voiceStatus.textContent = message;
}

function respond(message) {
  setVoiceStatus(message);
  showStatus(message, "");
  speak(message, () => {
    if (visionConsentPending || volunteerConsentPending) {
      startListening();
    }
  });
}

function announce(message) {
  setVoiceStatus(message);
  speak(message);
}

function speak(message, onEnd) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    if (onEnd) {
      setVoiceStatus(`${message} A fala automática não está disponível neste navegador.`);
      onEnd();
    }
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "pt-BR";
  utterance.rate = 0.95;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => {
    if (onEnd) {
      setVoiceStatus(`${message} A fala automática não está disponível neste navegador.`);
    }
  };
  window.speechSynthesis.speak(utterance);
}

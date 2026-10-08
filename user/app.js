(() => {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const AI_URL = "/api/ai/ask-image";
  const HELP_PHRASE = "preciso de ajuda";

  const elements = {
    openCamera: document.getElementById("open-camera"),
    cameraSection: document.getElementById("camera-section"),
    cameraPreview: document.getElementById("camera-preview"),
    capturePhoto: document.getElementById("capture-photo"),
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

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const socket = typeof window.io === "function" ? window.io() : null;

  let cameraStream = null;
  let photoBlob = null;
  let photoUrl = null;
  let recognition = null;
  let requestInProgress = false;
  let activeRequestId = null;
  let lastQuestion = "";
  let lastAnswer = "";

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setVoiceStatus(message) {
    elements.voiceStatus.textContent = message;
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    elements.cameraPreview.srcObject = null;
    elements.cameraPreview.hidden = true;
    elements.capturePhoto.hidden = true;
  }

  function stopRecognition() {
    if (!recognition) {
      return;
    }

    const activeRecognition = recognition;
    recognition = null;
    try {
      activeRecognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        setStatus("Não foi possível parar o microfone. Você pode continuar digitando.");
      }
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

  function speak(text, onEnd) {
    if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") {
      setStatus("A leitura em voz alta não está disponível. Use os controles da tela.");
      return false;
    }

    stopRecognition();
    window.speechSynthesis.cancel();

    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.onend = () => {
      if (typeof onEnd === "function") {
        onEnd();
      }
    };
    utterance.onerror = () => {
      setStatus("Não foi possível usar a voz. Você pode digitar sua pergunta ou tentar novamente.");
      elements.listenAgain.hidden = false;
    };

    try {
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      setStatus("A leitura em voz alta falhou. Use os controles da tela.");
      elements.listenAgain.hidden = false;
      return false;
    }
  }

  function focusTextQuestion() {
    elements.listenAgain.hidden = !photoBlob;
    elements.question.focus();
  }

  function listenForQuestion() {
    if (!SpeechRecognition) {
      setStatus("O reconhecimento de voz não está disponível. Digite sua pergunta.");
      focusTextQuestion();
      return;
    }

    stopRecognition();
    const currentRecognition = new SpeechRecognition();
    recognition = currentRecognition;
    currentRecognition.lang = "pt-BR";
    currentRecognition.continuous = false;
    currentRecognition.interimResults = false;
    currentRecognition.maxAlternatives = 1;

    currentRecognition.onstart = () => {
      elements.listenAgain.hidden = true;
      setStatus("Estou ouvindo. Diga sua pergunta ou um comando.");
      setVoiceStatus("Microfone ligado.");
    };

    currentRecognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (!transcript) {
        setStatus("Não entendi. Tente falar novamente ou digite sua pergunta.");
        elements.listenAgain.hidden = !photoBlob;
        return;
      }

      setVoiceStatus(`Você disse: ${transcript}`);
      handleVoiceCommand(transcript);
    };

    currentRecognition.onerror = (event) => {
      elements.listenAgain.hidden = !photoBlob;
      const messages = {
        "not-allowed": "Permita o uso do microfone nas configurações do navegador ou digite sua pergunta.",
        "service-not-allowed": "O navegador não permitiu usar o microfone. Você pode digitar sua pergunta.",
        "no-speech": "Não ouvi sua fala. Tente de novo ou digite sua pergunta.",
        "network": "O reconhecimento de voz falhou por um problema de rede. Você pode digitar sua pergunta."
      };
      setStatus(messages[event.error] || "O microfone não funcionou. Você pode digitar sua pergunta.");
      setVoiceStatus(messages[event.error] || "Falha no reconhecimento de voz.");
    };

    currentRecognition.onend = () => {
      if (recognition === currentRecognition) {
        recognition = null;
      }
      setVoiceStatus("");
    };

    try {
      currentRecognition.start();
    } catch (error) {
      recognition = null;
      elements.listenAgain.hidden = !photoBlob;
      setStatus("Não foi possível iniciar o microfone. Digite sua pergunta ou tente falar novamente.");
    }
  }

  function promptForQuestion() {
    const prompt =
      "Diga o que gostaria de saber sobre esta imagem. A foto será enviada quando sua pergunta for reconhecida.";
    setStatus("Aguardando sua pergunta.");
    if (!speak(prompt, listenForQuestion)) {
      focusTextQuestion();
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

  function handleVoiceCommand(transcript) {
    const command = normalizeCommand(transcript);

    if (command.includes(HELP_PHRASE)) {
      createVolunteerRequest();
      return;
    }

    if (command.includes("tirar outra foto") || command.includes("nova foto")) {
      startCamera();
      return;
    }

    if (command.includes("repetir resposta") && lastAnswer) {
      readAnswer(lastAnswer);
      return;
    }

    if (command.includes("repetir pergunta") && lastQuestion) {
      submitQuestion(lastQuestion);
      return;
    }

    if (!photoBlob) {
      setStatus("Para fazer uma pergunta, tire uma foto primeiro.");
      speak("Para fazer uma pergunta, tire uma foto primeiro.", () => {});
      return;
    }

    submitQuestion(transcript);
  }

  function showPhoto(blob) {
    stopCamera();
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
    photoBlob = blob;
    photoUrl = URL.createObjectURL(blob);
    elements.photoPreview.src = photoUrl;
    elements.photoSection.hidden = false;
    elements.cameraSection.hidden = true;
    elements.listenAgain.hidden = true;
    elements.question.value = "";
    setStatus("Foto pronta. Vou pedir sua pergunta.");
    promptForQuestion();
  }

  async function startCamera() {
    stopRecognition();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    clearPhoto();
    elements.photoFile.value = "";
    elements.cameraSection.hidden = false;
    elements.filePickerButton.hidden = false;
    elements.openCamera.textContent = "Abrir câmera novamente";
    setStatus("Solicitando acesso à câmera.");

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setStatus("A câmera direta não está disponível. Use o controle para tirar ou escolher uma foto.");
      elements.filePickerButton.focus();
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } }
      });
      elements.cameraPreview.srcObject = cameraStream;
      elements.cameraPreview.hidden = false;
      elements.capturePhoto.hidden = false;
      elements.filePickerButton.hidden = false;
      await elements.cameraPreview.play();
      setStatus("Câmera pronta. Enquadre a imagem e tire a foto.");
      elements.capturePhoto.focus();
    } catch (error) {
      stopCamera();
      if (error.name === "OverconstrainedError" || error.name === "TypeError") {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
          });
          elements.cameraPreview.srcObject = cameraStream;
          elements.cameraPreview.hidden = false;
          elements.capturePhoto.hidden = false;
          await elements.cameraPreview.play();
          setStatus("Câmera pronta. Enquadre a imagem e tire a foto.");
          elements.capturePhoto.focus();
          return;
        } catch (fallbackError) {
          stopCamera();
          setStatus("Não foi possível abrir a câmera. Use o controle para tirar ou escolher uma foto.");
          elements.filePickerButton.focus();
          return;
        }
      }

      setStatus("Não foi possível abrir a câmera. Verifique a permissão ou use o controle para tirar ou escolher uma foto.");
      elements.filePickerButton.focus();
    }
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Não foi possível criar a foto."));
          }
        },
        "image/jpeg",
        quality
      );
    });
  }

  async function capturePhoto() {
    const video = elements.cameraPreview;
    if (!cameraStream || !video.videoWidth || !video.videoHeight) {
      setStatus("A câmera ainda está sendo preparada. Tente novamente em instantes.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setStatus("Não foi possível preparar a foto. Use a opção para escolher uma imagem.");
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const blob = await canvasToJpeg(canvas, 0.95);
      if (blob.size > MAX_IMAGE_BYTES) {
        setStatus("A foto ficou grande demais para enviar. Tente uma imagem menor.");
        return;
      }
      showPhoto(blob);
    } catch (error) {
      setStatus("Não foi possível preparar a foto. Tente novamente ou escolha uma imagem.");
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
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
    showPhoto(file);
  }

  async function submitQuestion(question) {
    const cleanQuestion = question.trim();
    if (!photoBlob || !cleanQuestion) {
      setStatus("Diga ou digite uma pergunta sobre a foto.");
      elements.question.focus();
      return;
    }
    if (requestInProgress) {
      return;
    }

    lastQuestion = cleanQuestion;
    stopRecognition();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
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
        body: photoBlob
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true || typeof result.answer !== "string") {
        throw new Error(
          response.status === 413
            ? "A imagem ultrapassa o limite aceito. Tire outra foto ou escolha uma imagem menor."
            : "Não foi possível obter uma resposta agora."
        );
      }

      lastAnswer = result.answer;
      setStatus("Resposta recebida.");
      readAnswer(result.answer);
    } catch (error) {
      const message =
        error instanceof TypeError
          ? "Falha de rede ao enviar a imagem. Verifique sua conexão e tente novamente."
          : error.message || "O serviço de IA falhou. Tente novamente.";
      setStatus(message);
      elements.listenAgain.hidden = false;
      speak(message, listenForQuestion);
    } finally {
      requestInProgress = false;
      elements.questionForm.querySelector("button[type='submit']").disabled = false;
    }
  }

  function readAnswer(answer) {
    const followUp =
      " Se quiser continuar, diga outra pergunta. Você também pode dizer repetir resposta, repetir pergunta, tirar outra foto ou preciso de ajuda.";
    setStatus("Lendo a resposta. Depois, você poderá fazer outra pergunta por voz.");
    if (!speak(`${answer}${followUp}`, listenForQuestion)) {
      elements.listenAgain.hidden = false;
    }
  }

  async function createVolunteerRequest() {
    stopRecognition();
    stopCamera();
    elements.cameraSection.hidden = true;
    if (activeRequestId) {
      setStatus("Você já tem um pedido de ajuda aguardando resposta.");
      speak("Você já tem um pedido de ajuda aguardando resposta.", listenForQuestion);
      return;
    }
    if (!socket?.connected) {
      const message = "Não foi possível conectar aos voluntários. Verifique a rede e tente pedir ajuda novamente.";
      setStatus(message);
      elements.listenAgain.hidden = !photoBlob;
      speak(message, listenForQuestion);
      return;
    }
    setStatus("Enviando seu pedido de ajuda para os voluntários.");
    elements.requestPanel.hidden = false;
    elements.requestMessage.textContent = "Enviando pedido. Aguarde a confirmação do sistema.";
    elements.cancelRequest.hidden = true;

    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userName: "Pessoa usuária",
          type: "visual_assistance",
          ...(socket?.id ? { socketId: socket.id } : {})
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.request?.id) {
        throw new Error("Não foi possível registrar seu pedido de ajuda.");
      }

      activeRequestId = result.request.id;
      elements.requestMessage.textContent =
        "Seu pedido foi enviado. Ainda não há confirmação de um voluntário.";
      elements.cancelRequest.hidden = false;
      setStatus("Pedido registrado. Aguardando um voluntário.");
      speak(
        "Seu pedido foi enviado. Aguarde a confirmação de um voluntário. Você ainda pode fazer outra pergunta ou pedir uma nova foto.",
        listenForQuestion
      );
    } catch (error) {
      elements.requestMessage.textContent = error.message;
      setStatus(error.message);
      elements.listenAgain.hidden = !photoBlob;
      speak(error.message, listenForQuestion);
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
      setStatus("Pedido cancelado.");
      speak("Seu pedido foi cancelado.", () => {});
    } catch (error) {
      setStatus(error.message);
      elements.requestMessage.textContent = error.message;
    } finally {
      elements.cancelRequest.disabled = false;
    }
  }

  elements.openCamera.addEventListener("click", startCamera);
  elements.capturePhoto.addEventListener("click", capturePhoto);
  elements.filePickerButton.addEventListener("click", () => elements.photoFile.click());
  elements.photoFile.addEventListener("change", handleSelectedFile);
  elements.retakePhoto.addEventListener("click", startCamera);
  elements.listenAgain.addEventListener("click", listenForQuestion);
  elements.questionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitQuestion(elements.question.value);
  });
  elements.cancelRequest.addEventListener("click", cancelVolunteerRequest);

  if (socket) {
    socket.on("request_accepted", (request) => {
      if (request.id !== activeRequestId) {
        return;
      }
      activeRequestId = null;
      const volunteer = request.volunteerName || "Um voluntário";
      elements.requestMessage.textContent = `${volunteer} aceitou seu pedido.`;
      elements.cancelRequest.hidden = true;
      setStatus(`${volunteer} aceitou seu pedido de ajuda.`);
      speak(`${volunteer} aceitou seu pedido de ajuda.`, listenForQuestion);
    });

    socket.on("request_cancelled", (request) => {
      if (request.id !== activeRequestId) {
        return;
      }
      activeRequestId = null;
      elements.requestMessage.textContent = "O pedido foi cancelado.";
      elements.cancelRequest.hidden = true;
      setStatus("O pedido foi cancelado.");
      speak("O pedido foi cancelado.", listenForQuestion);
    });
  }

  window.addEventListener("pagehide", () => {
    stopRecognition();
    stopCamera();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
    }
  });
})();

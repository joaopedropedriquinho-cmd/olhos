const API_URL = "https://olhos-xnia.onrender.com";
const socket = io({ auth: { role: "volunteer" } });
const requestList = document.querySelector("#request-list");
const emptyState = document.querySelector("#empty-state");
const requestCount = document.querySelector("#request-count");
const presenceDot = document.querySelector("#presence-dot");
const presenceLabel = document.querySelector("#presence-label");
const toggleOnlineButton = document.querySelector("#toggle-online");
const acceptedPanel = document.querySelector("#accepted-panel");
const acceptedDetails = document.querySelector("#accepted-details");
const errorMessage = document.querySelector("#error-message");
const requests = new Map();
let isOnline = true;

socket.on("connect", async () => {
  setPresence(true);
  toggleOnlineButton.disabled = false;
  await loadRequests();
});

socket.on("disconnect", () => {
  setPresence(false, "Reconectandoâ€¦");
});

socket.on("new_request", (request) => {
  requests.set(request.id, request);
  renderRequests();
});

socket.on("request_accepted", (request) => {
  requests.delete(request.id);
  renderRequests();
});

socket.on("request_cancelled", (request) => {
  requests.delete(request.id);
  renderRequests();
});

toggleOnlineButton.addEventListener("click", () => {
  if (isOnline) {
    isOnline = false;
    socket.disconnect();
    setPresence(false, "VoluntÃ¡rio offline");
    toggleOnlineButton.textContent = "Ficar online";
    toggleOnlineButton.className = "button button-online";
  } else {
    isOnline = true;
    toggleOnlineButton.disabled = true;
    toggleOnlineButton.textContent = "Conectandoâ€¦";
    socket.connect();
  }
});

async function loadRequests() {
  try {
    const response = await fetch(`${API_URL}/api/requests`);
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "NÃ£o foi possÃ­vel carregar os pedidos.");
    }
    for (const request of result.requests) {
      if (request.status === "pending") {
        requests.set(request.id, request);
      }
    }
    renderRequests();
  } catch (error) {
    showError(error.message);
  }
}

async function acceptRequest(request) {
  const button = requestList.querySelector(`[data-request-id="${CSS.escape(request.id)}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "Aceitandoâ€¦";
  }

  try {
    const response = await fetch(`${API_URL}/api/requests/${encodeURIComponent(request.id)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volunteerName: "VoluntÃ¡rio" })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "NÃ£o foi possÃ­vel aceitar o pedido.");
    }
    requests.delete(request.id);
    acceptedPanel.hidden = false;
    acceptedDetails.textContent =
      `${result.request.userName} precisa de ${formatHelpType(result.request.type)}. ` +
      `Pedido recebido ${formatTime(result.request.createdAt)}.`;
    showError("");
    renderRequests();
  } catch (error) {
    showError(error.message);
    if (button) {
      button.disabled = false;
      button.textContent = "ACEITAR";
    }
    if (error.message.includes("nÃ£o estÃ¡ mais disponÃ­vel")) {
      requests.delete(request.id);
      renderRequests();
    }
  }
}

function renderRequests() {
  requestList.replaceChildren();
  const availableRequests = [...requests.values()]
    .filter((request) => request.status === "pending")
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));

  for (const request of availableRequests) {
    const card = document.createElement("article");
    card.className = "request-card";
    const name = document.createElement("h2");
    name.textContent = request.userName;
    const details = document.createElement("p");
    details.className = "request-meta";
    details.textContent =
      `Ajuda: ${formatHelpType(request.type)}\nRecebido: ${formatTime(request.createdAt)}`;
    const acceptButton = document.createElement("button");
    acceptButton.className = "button button-accept";
    acceptButton.type = "button";
    acceptButton.dataset.requestId = request.id;
    acceptButton.textContent = "ACEITAR";
    acceptButton.addEventListener("click", () => acceptRequest(request));
    card.append(name, details, acceptButton);
    requestList.append(card);
  }

  emptyState.hidden = availableRequests.length > 0;
  requestCount.textContent = `${availableRequests.length} ${
    availableRequests.length === 1 ? "pedido" : "pedidos"
  }`;
}

function setPresence(online, label = online ? "VoluntÃ¡rio online" : "VoluntÃ¡rio offline") {
  presenceDot.classList.toggle("online", online);
  presenceLabel.textContent = label;
}

function formatHelpType(type) {
  return type === "visual_assistance" ? "assistÃªncia visual" : type;
}

function formatTime(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(date));
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}



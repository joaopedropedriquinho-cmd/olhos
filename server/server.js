const path = require("node:path");
const http = require("node:http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { port, host, isAllowedOrigin } = require("./src/config");
const InMemoryRequestRepository = require("./src/requests/inMemoryRequestRepository");
const RequestService = require("./src/requests/requestService");
const createRequestRouter = require("./src/requests/requestRoutes");
const createRealtime = require("./src/realtime");
const MockVisionProvider = require("./src/assistant/mockVisionProvider");
const VisionService = require("./src/assistant/visionService");
const createAssistantRouter = require("./src/assistant/assistantRoutes");
const createMobileRouter = require("./src/mobile/mobileRoutes");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true
  },
  allowRequest(request, callback) {
    callback(
      null,
      isAllowedOrigin(request.headers.origin, request.headers.host)
    );
  }
});
const realtime = createRealtime(io);
const requestRepository = new InMemoryRequestRepository();
const requestService = new RequestService(requestRepository, realtime);
const visionService = new VisionService(new MockVisionProvider());
const projectRoot = path.resolve(__dirname, "..");

app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin, req.get("host"))) {
        return callback(null, true);
      }
      const error = new Error("Origem não permitida pelo CORS.");
      error.status = 403;
      return callback(error);
    }
  })(req, res, next);
});
app.use(express.json({ limit: "3mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/requests", createRequestRouter(requestService));
app.use("/api/mobile", createMobileRouter(requestService));
app.use("/api/assistant", createAssistantRouter(visionService));

app.use("/user", express.static(path.join(projectRoot, "user")));
app.use("/volunteer", express.static(path.join(projectRoot, "volunteer")));
app.get("/", (_req, res) => res.redirect("/user/"));

app.use((error, _req, res, _next) => {
  console.error("Erro ao processar a requisição:", error);
  if (res.headersSent) {
    return;
  }
  if (error.status === 403) {
    return res.status(403).json({ error: error.message });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    if (_req.originalUrl.startsWith("/api/mobile/")) {
      return res.status(400).json({
        success: false,
        message: "O corpo da requisição não é um JSON válido."
      });
    }
    return res.status(400).json({ error: "O corpo da requisição não é um JSON válido." });
  }
  if (_req.originalUrl.startsWith("/api/mobile/") && error.status === 413) {
    return res.status(413).json({
      success: false,
      message: "O conteúdo enviado excede o limite permitido."
    });
  }
  if (error.status === 400) {
    return res.status(400).json({ error: error.message });
  }
  if (error.status === 413) {
    return res.status(413).json({ error: "O conteúdo enviado excede o limite permitido." });
  }
  return res.status(500).json({ error: "Erro interno do servidor." });
});

httpServer.listen(port, host, () => {
  console.log(`Meus Olhos disponível em http://${host}:${port}`);
});

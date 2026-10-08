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
const { AiAnalysisService } = require("./src/ai/aiAnalysisService");
const GeminiVisionProvider = require("./src/ai/geminiVisionProvider");
const createAiRouter = require("./src/ai/aiRoutes");
const createMobileRouter = require("./src/mobile/mobileRoutes");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true
  },
  allowRequest(request, callback) {
    const origin = request.headers.origin;

    const allowed =
      !origin ||
      origin === "https://olhos-1-ynwb.onrender.com" ||
      isAllowedOrigin(origin, request.headers.host);

    callback(null, allowed);
  }
});
const realtime = createRealtime(io);
const requestRepository = new InMemoryRequestRepository();
const requestService = new RequestService(requestRepository, realtime);
const visionService = new VisionService(new MockVisionProvider());
const aiAnalysisService = new AiAnalysisService(new GeminiVisionProvider());
const projectRoot = path.resolve(__dirname, "..");

app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin, req.get("host"))) {
        return callback(null, true);
      }
      const error = new Error("Origem nÃ£o permitida pelo CORS.");
      error.status = 403;
      return callback(error);
    }
  })(req, res, next);
});
app.use("/api/ai", createAiRouter(aiAnalysisService));
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
  console.error("Erro ao processar a requisiÃ§Ã£o:", error);
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
        message: "O corpo da requisiÃ§Ã£o nÃ£o Ã© um JSON vÃ¡lido."
      });
    }
    return res.status(400).json({ error: "O corpo da requisiÃ§Ã£o nÃ£o Ã© um JSON vÃ¡lido." });
  }
  if (_req.originalUrl.startsWith("/api/mobile/") && error.status === 413) {
    return res.status(413).json({
      success: false,
      message: "O conteÃºdo enviado excede o limite permitido."
    });
  }
  if (error.status === 400) {
    return res.status(400).json({ error: error.message });
  }
  if (error.status === 413) {
    return res.status(413).json({ error: "O conteÃºdo enviado excede o limite permitido." });
  }
  return res.status(500).json({ error: "Erro interno do servidor." });
});

httpServer.listen(port, host, () => {
  console.log(`Meus Olhos disponÃ­vel em http://${host}:${port}`);
});

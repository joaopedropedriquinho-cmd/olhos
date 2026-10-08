const express = require("express");
const { MAX_IMAGE_BYTES, parseImageRequest } = require("./aiAnalysisService");

const FAILURE_RESPONSE = {
  success: false,
  message: "Não foi possível analisar a imagem."
};
const QUOTA_FAILURE_RESPONSE = {
  success: false,
  message: "A IA está temporariamente indisponível. Tente novamente mais tarde."
};
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

function createAiRouter(aiAnalysisService) {
  const router = express.Router();

  router.post(
    "/analyze",
    express.raw({ type: IMAGE_MIME_TYPES, limit: MAX_IMAGE_BYTES }),
    express.json({ limit: "7mb" }),
    async (req, res) => {
      try {
        const image = parseImageRequest(req);
        const description = await aiAnalysisService.analyzeImage(image);
        return res.json({ success: true, description });
      } catch (error) {
        if (error.upstreamStatus === 429) {
          console.error("Gemini API limitou a análise por cota ou frequência.");
          return res.status(503).json(QUOTA_FAILURE_RESPONSE);
        }

        const status = error.status || (error.code === "AI_API_KEY_MISSING" ? 503 : 502);
        if (error.code === "AI_API_KEY_MISSING") {
          console.error("AI_API_KEY não está configurada para análise de imagem.");
        } else if (!error.status) {
          const upstreamStatus = Number.isInteger(error.upstreamStatus)
            ? ` HTTP ${error.upstreamStatus}`
            : "";
          console.error(`Não foi possível concluir a análise da imagem.${upstreamStatus}`);
        }
        return res.status(status).json(FAILURE_RESPONSE);
      }
    }
  );

  router.use((error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    console.error("Não foi possível ler a imagem enviada para análise.");
    return res.status(status).json(FAILURE_RESPONSE);
  });

  return router;
}

module.exports = createAiRouter;

const express = require("express");
const { MAX_IMAGE_BYTES, parseImageRequest } = require("./aiAnalysisService");

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const FAILURE_RESPONSE = {
  success: false,
  message: "Não foi possível analisar a imagem."
};
const QUOTA_FAILURE_RESPONSE = {
  success: false,
  message: "A IA está temporariamente indisponível. Tente novamente mais tarde."
};
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

function summarizeModel(model) {
  const summary = {
    name: model.name,
    displayName: model.displayName,
    supportedGenerationMethods: Array.isArray(model.supportedGenerationMethods)
      ? model.supportedGenerationMethods
      : []
  };

  if (Number.isInteger(model.inputTokenLimit)) {
    summary.inputTokenLimit = model.inputTokenLimit;
  }

  return summary;
}

async function listImageAnalysisCandidates(apiKey, fetchImpl) {
  const models = [];
  let pageToken;
  const seenPageTokens = new Set();

  do {
    const url = new URL(GEMINI_MODELS_URL);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchImpl(url, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      const error = new Error(`Gemini model listing returned HTTP ${response.status}.`);
      error.upstreamStatus = response.status;
      throw error;
    }

    const body = await response.json();
    const listedModels = Array.isArray(body.models) ? body.models : [];
    models.push(
      ...listedModels.filter(
        (model) =>
          typeof model.name === "string" &&
          /^models\/gemini-/i.test(model.name) &&
          !/(?:-tts|-live|audio|transcrib|embed)/i.test(model.name) &&
          Array.isArray(model.supportedGenerationMethods) &&
          model.supportedGenerationMethods.includes("generateContent")
      )
    );

    pageToken = body.nextPageToken;
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new Error("Gemini model listing returned a repeated page token.");
    }
    if (pageToken) {
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);

  return models.map(summarizeModel);
}

function getRequestSizes(req) {
  const declaredBodyBytes = Number(req.get("content-length"));
  const bodyBytes = Number.isFinite(declaredBodyBytes)
    ? declaredBodyBytes
    : Buffer.isBuffer(req.body)
      ? req.body.length
      : Buffer.byteLength(JSON.stringify(req.body || {}));

  if (Buffer.isBuffer(req.body)) {
    return `body=${bodyBytes} bytes image=${req.body.length} bytes`;
  }

  const dataUrl = req.body?.imageDataUrl;
  if (typeof dataUrl !== "string") {
    return `body=${bodyBytes} bytes image=unknown`;
  }

  const base64Start = dataUrl.indexOf(",");
  if (base64Start < 0) {
    return `body=${bodyBytes} bytes image=unknown`;
  }

  const base64 = dataUrl.slice(base64Start + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const imageBytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return `body=${bodyBytes} bytes image=${imageBytes} bytes`;
}

function createAiRouter(
  aiAnalysisService,
  { getApiKey = () => process.env.AI_API_KEY, fetchImpl = globalThis.fetch } = {}
) {
  const router = express.Router();

  router.get("/diagnostics/models", async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        message: "O diagnóstico de modelos não está configurado."
      });
    }

    try {
      const models = await listImageAnalysisCandidates(apiKey, fetchImpl);
      return res.json({
        success: true,
        imageAnalysisCandidates: models
      });
    } catch (error) {
      console.error(
        `Falha ao consultar modelos Gemini${Number.isInteger(error.upstreamStatus)
          ? ` HTTP ${error.upstreamStatus}`
          : ""}.`
      );
      return res.status(502).json({
        success: false,
        message: "Não foi possível consultar os modelos Gemini."
      });
    }
  });

  router.post(
    "/analyze",
    (req, _res, next) => {
      console.info("[AI] request received");
      console.info(`[AI] content-type=${req.get("content-type") || "unknown"}`);
      next();
    },
    express.raw({ type: IMAGE_MIME_TYPES, limit: MAX_IMAGE_BYTES }),
    express.json({ limit: "7mb" }),
    (req, _res, next) => {
      console.info(`[AI] body/image size=${getRequestSizes(req)}`);
      next();
    },
    async (req, res) => {
      try {
        const image = parseImageRequest(req);
        console.info("[AI] calling analysis service");
        const description = await aiAnalysisService.analyzeImage(image);
        console.info("[GEMINI] success");
        return res.json({ success: true, description });
      } catch (error) {
        if (Number.isInteger(error.upstreamStatus) || error.upstreamBody) {
          const status = Number.isInteger(error.upstreamStatus)
            ? error.upstreamStatus
            : "unavailable";
          console.error(`[GEMINI ERROR] status=${status}`);
          console.error(`[GEMINI ERROR] body=${error.upstreamBody || ""}`);
        }

        if (error.upstreamStatus === 429) {
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
    console.info(`[AI] body/image size=${getRequestSizes(_req)}`);
    console.error("Não foi possível ler a imagem enviada para análise.");
    return res.status(status).json(FAILURE_RESPONSE);
  });

  return router;
}

module.exports = createAiRouter;

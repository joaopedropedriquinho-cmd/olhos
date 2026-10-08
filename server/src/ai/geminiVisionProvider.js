const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-2.5-flash";
const MAX_ERROR_BODY_LENGTH = 4_000;
const FALLBACK_RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const DESCRIPTION_PROMPT =
  "Descreva esta imagem em português brasileiro para uma pessoa cega. " +
  "Seja objetivo, conciso e use frases naturais, adequadas para leitura em voz alta. " +
  "Descreva somente informações úteis; priorize pessoas, objetos, obstáculos, textos visíveis, " +
  "o ambiente e ações importantes. Informe cores relevantes e posições relativas quando ajudarem " +
  "a compreender a cena. Não invente nem deduza informações que não estejam visíveis. " +
  "Quando algo importante não puder ser identificado com segurança, diga isso claramente.";

function sanitizeErrorBody(body, apiKey, imageBase64) {
  let sanitized = body
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[IMAGE_DATA_REDACTED]")
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[BASE64_REDACTED]");

  if (imageBase64) {
    sanitized = sanitized.split(imageBase64).join("[IMAGE_DATA_REDACTED]");
  }
  if (apiKey) {
    sanitized = sanitized.split(apiKey).join("[API_KEY_REDACTED]");
  }

  return sanitized.length > MAX_ERROR_BODY_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_BODY_LENGTH)}...[TRUNCATED]`
    : sanitized;
}

function extractDescription(responseBody) {
  const interaction = responseBody.interaction || responseBody;
  if (typeof interaction.output_text === "string") {
    return interaction.output_text.trim();
  }

  if (!Array.isArray(interaction.outputs)) {
    return "";
  }

  return interaction.outputs
    .flatMap((output) => (Array.isArray(output.content) ? output.content : [output]))
    .filter((item) => item.type === "text" || typeof item.text === "string")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n")
    .trim();
}

class GeminiVisionProvider {
  constructor({ apiKey = process.env.AI_API_KEY, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async describeImage({ buffer, mimeType }) {
    if (!this.apiKey) {
      const error = new Error("AI_API_KEY não está configurada.");
      error.code = "AI_API_KEY_MISSING";
      throw error;
    }

    if (typeof this.fetchImpl !== "function") {
      throw new Error("A API fetch do Node.js não está disponível.");
    }

    const imageBase64 = buffer.toString("base64");
    const requestModel = async (model) => {
      const requestStartedAt = Date.now();
      console.info(`[GEMINI] request starting model=${model}`);
      let response;
      try {
        response = await this.fetchImpl(GEMINI_INTERACTIONS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify({
            model,
            input: [
              { type: "text", text: DESCRIPTION_PROMPT },
              {
                type: "image",
                data: imageBase64,
                mime_type: mimeType
              }
            ]
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (cause) {
        const elapsedMs = Date.now() - requestStartedAt;
        const isTimeout =
          cause instanceof Error &&
          (cause.name === "TimeoutError" || cause.name === "AbortError");
        if (isTimeout) {
          console.error(`[GEMINI ERROR] timeout after ${elapsedMs} ms model=${model}`);
        }

        const error = new Error("Falha de comunicação com a Gemini API.");
        error.retryableUnavailable = isTimeout;
        error.upstreamBody = sanitizeErrorBody(
          cause instanceof Error ? cause.message : "Falha de rede desconhecida.",
          this.apiKey,
          imageBase64
        );
        throw error;
      }

      console.info(
        `[GEMINI] request finished in ${Date.now() - requestStartedAt} ms status=${response.status}`
      );
      console.info(`[GEMINI] response status=${response.status}`);
      if (!response.ok) {
        let responseBody;
        try {
          responseBody = await response.text();
        } catch {
          responseBody = "Não foi possível ler o corpo de erro da Gemini.";
        }

        const error = new Error(`Gemini API respondeu HTTP ${response.status}.`);
        error.upstreamStatus = response.status;
        error.upstreamBody = sanitizeErrorBody(responseBody, this.apiKey, imageBase64);
        throw error;
      }

      let responseText;
      try {
        responseText = await response.text();
      } catch {
        const error = new Error("Não foi possível ler a resposta da Gemini API.");
        error.upstreamStatus = response.status;
        error.upstreamBody = "Não foi possível ler o corpo da resposta.";
        throw error;
      }

      let responseBody;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        const error = new Error("Gemini API retornou uma resposta JSON inválida.");
        error.upstreamStatus = response.status;
        error.upstreamBody = sanitizeErrorBody(responseText, this.apiKey, imageBase64);
        throw error;
      }

      const description = extractDescription(responseBody);
      if (!description) {
        const error = new Error("Gemini API não retornou uma descrição.");
        error.upstreamStatus = response.status;
        error.upstreamBody = sanitizeErrorBody(responseText, this.apiKey, imageBase64);
        throw error;
      }

      return description;
    };

    const isRetryableUnavailable = (error) =>
      error.upstreamStatus === 503 || error.retryableUnavailable === true;

    try {
      return await requestModel(MODEL);
    } catch (error) {
      if (!isRetryableUnavailable(error)) {
        throw error;
      }
    }

    console.info("[GEMINI] primary model unavailable, trying fallback model");
    try {
      return await requestModel(FALLBACK_MODEL);
    } catch (error) {
      if (!isRetryableUnavailable(error)) {
        throw error;
      }
    }

    console.info("[GEMINI] fallback model unavailable, retrying fallback");
    await new Promise((resolve) => setTimeout(resolve, FALLBACK_RETRY_DELAY_MS));
    return requestModel(FALLBACK_MODEL);
  }
}

module.exports = GeminiVisionProvider;

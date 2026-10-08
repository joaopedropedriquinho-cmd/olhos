const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-3.8-flash";
const DESCRIPTION_PROMPT =
  "Descreva esta imagem em português brasileiro para uma pessoa cega. " +
  "Seja objetivo, conciso e use frases naturais, adequadas para leitura em voz alta. " +
  "Descreva somente informações úteis; priorize pessoas, objetos, obstáculos, textos visíveis, " +
  "o ambiente e ações importantes. Informe cores relevantes e posições relativas quando ajudarem " +
  "a compreender a cena. Não invente nem deduza informações que não estejam visíveis. " +
  "Quando algo importante não puder ser identificado com segurança, diga isso claramente.";

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

    const response = await this.fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: "text", text: DESCRIPTION_PROMPT },
          {
            type: "image",
            data: buffer.toString("base64"),
            mime_type: mimeType
          }
        ]
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      const error = new Error(`Gemini API respondeu HTTP ${response.status}.`);
      error.upstreamStatus = response.status;
      throw error;
    }

    const responseBody = await response.json();
    const description = extractDescription(responseBody);
    if (!description) {
      throw new Error("Gemini API não retornou uma descrição.");
    }

    return description;
  }
}

module.exports = GeminiVisionProvider;

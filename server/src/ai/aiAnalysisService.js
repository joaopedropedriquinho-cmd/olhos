const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_DATA_URL_HEADER_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function invalidImage(status = 400) {
  const error = new Error("Imagem ausente ou inválida.");
  error.status = status;
  return error;
}

function hasExpectedSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  }
  return (
    mimeType === "image/webp" &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  );
}

function detectImageMimeType(buffer) {
  return ["image/jpeg", "image/png", "image/webp"].find((mimeType) =>
    hasExpectedSignature(buffer, mimeType)
  );
}

function validateImage(buffer, mimeType) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0 ||
    buffer.length > MAX_IMAGE_BYTES ||
    !["image/jpeg", "image/png", "image/webp"].includes(mimeType) ||
    !hasExpectedSignature(buffer, mimeType)
  ) {
    throw invalidImage(buffer?.length > MAX_IMAGE_BYTES ? 413 : 400);
  }

  return { buffer, mimeType };
}

function parseImageRequest(req) {
  if (Buffer.isBuffer(req.body)) {
    const declaredMimeType = req.is(["image/jpeg", "image/png", "image/webp"]);
    const mimeType =
      declaredMimeType ||
      (req.is("application/x-www-form-urlencoded")
        ? detectImageMimeType(req.body)
        : undefined);
    return validateImage(req.body, mimeType);
  }

  const dataUrl = req.body?.imageDataUrl;
  if (typeof dataUrl !== "string") {
    throw invalidImage();
  }

  const match = IMAGE_DATA_URL_HEADER_PATTERN.exec(dataUrl);
  if (!match) {
    throw invalidImage();
  }

  const [, mimeType] = match;
  const base64 = dataUrl.slice(match[0].length);
  if (base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
    throw invalidImage(413);
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.toString("base64") !== base64) {
    throw invalidImage();
  }

  return validateImage(buffer, mimeType);
}

function sanitizeServiceError(error, provider, image) {
  let message = error instanceof Error ? error.message : "Erro desconhecido.";
  const apiKey = provider.apiKey;
  if (apiKey) {
    message = message.split(apiKey).join("[API_KEY_REDACTED]");
  }

  if (image?.buffer) {
    const imageBase64 = image.buffer.toString("base64");
    message = message.split(imageBase64).join("[IMAGE_DATA_REDACTED]");
  }

  return message
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[IMAGE_DATA_REDACTED]")
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[BASE64_REDACTED]")
    .slice(0, 1_000);
}

class AiAnalysisService {
  constructor(provider) {
    this.provider = provider;
  }

  async analyzeImage(image) {
    try {
      return await this.provider.describeImage(image);
    } catch (error) {
      console.error(`[AI SERVICE ERROR] ${sanitizeServiceError(error, this.provider, image)}`);
      throw error;
    }
  }

  async askImage(image, question) {
    try {
      return await this.provider.answerQuestion(image, question);
    } catch (error) {
      const status = Number.isInteger(error.upstreamStatus)
        ? error.upstreamStatus
        : error.code || "unavailable";
      console.error(`[AI ASK SERVICE ERROR] status=${status}`);
      throw error;
    }
  }
}

module.exports = {
  AiAnalysisService,
  MAX_IMAGE_BYTES,
  parseImageRequest
};

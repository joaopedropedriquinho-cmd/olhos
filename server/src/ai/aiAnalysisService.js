const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_DATA_URL_PATTERN =
  /^data:(image\/(?:jpeg|png|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;
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
    return validateImage(req.body, req.is(["image/jpeg", "image/png", "image/webp"]));
  }

  const dataUrl = req.body?.imageDataUrl;
  if (typeof dataUrl !== "string") {
    throw invalidImage();
  }

  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw invalidImage();
  }

  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.toString("base64") !== base64) {
    throw invalidImage();
  }

  return validateImage(buffer, mimeType);
}

class AiAnalysisService {
  constructor(provider) {
    this.provider = provider;
  }

  async analyzeImage(image) {
    return this.provider.describeImage(image);
  }
}

module.exports = {
  AiAnalysisService,
  MAX_IMAGE_BYTES,
  parseImageRequest
};

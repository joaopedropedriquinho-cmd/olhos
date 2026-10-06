const MAX_IMAGE_DATA_URL_LENGTH = 2_800_000;
const JPEG_DATA_URL_PATTERN = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

class VisionService {
  constructor(provider) {
    this.provider = provider;
  }

  async describeImage(imageDataUrl) {
    if (
      typeof imageDataUrl !== "string" ||
      imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH ||
      !JPEG_DATA_URL_PATTERN.test(imageDataUrl)
    ) {
      const error = new Error("Imagem JPEG inválida ou maior que o limite permitido.");
      error.status = 400;
      throw error;
    }

    return this.provider.describeImage(imageDataUrl);
  }
}

module.exports = VisionService;

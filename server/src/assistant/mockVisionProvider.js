class MockVisionProvider {
  async describeImage(_imageDataUrl) {
    return {
      status: "unavailable",
      spokenResponse:
        "A inteligência artificial de visão ainda não está configurada. " +
        "Não consigo confirmar o que aparece na imagem e não vou adivinhar."
    };
  }
}

module.exports = MockVisionProvider;

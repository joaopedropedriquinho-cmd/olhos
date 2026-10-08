const assert = require("node:assert/strict");
const { once } = require("node:events");
const express = require("express");
const { test } = require("node:test");
const createAiRouter = require("../src/ai/aiRoutes");
const {
  AiAnalysisService,
  MAX_IMAGE_BYTES,
  parseImageRequest
} = require("../src/ai/aiAnalysisService");
const GeminiVisionProvider = require("../src/ai/geminiVisionProvider");

const PNG_IMAGE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00
]);
const JPEG_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const WEBP_IMAGE = Buffer.from("RIFF0000WEBP", "ascii");

function geminiResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return typeof payload === "string" ? JSON.parse(payload) : payload;
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    }
  };
}

async function startTestServer(t, aiAnalysisService, routerOptions) {
  const app = express();
  app.use("/api/ai", createAiRouter(aiAnalysisService, routerOptions));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /api/ai/diagnostics/models uses the server API key and returns summarized image candidates", async (t) => {
  const apiKey = "diagnostic-test-key";
  let upstreamUrl;
  let upstreamOptions;
  const baseUrl = await startTestServer(t, {}, {
    getApiKey: () => apiKey,
    fetchImpl: async (url, options) => {
      upstreamUrl = url.toString();
      upstreamOptions = options;
      return {
        ok: true,
        async json() {
          return {
            models: [
              {
                name: "models/gemini-3.7-flash",
                displayName: "Gemini 3.7 Flash",
                supportedGenerationMethods: ["generateContent", "countTokens"],
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 8_192,
                description: "must not be returned"
              },
              {
                name: "models/gemini-tts",
                displayName: "Gemini TTS",
                supportedGenerationMethods: ["generateContent"]
              },
              {
                name: "models/gemini-embedding",
                displayName: "Gemini Embedding",
                supportedGenerationMethods: ["embedContent"]
              },
              {
                name: "models/gemma-vision",
                displayName: "Gemma vision",
                supportedGenerationMethods: ["generateContent"]
              }
            ]
          };
        }
      };
    }
  });

  const response = await fetch(`${baseUrl}/api/ai/diagnostics/models`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    success: true,
    imageAnalysisCandidates: [
      {
        name: "models/gemini-3.7-flash",
        displayName: "Gemini 3.7 Flash",
        supportedGenerationMethods: ["generateContent", "countTokens"],
        inputTokenLimit: 1_048_576
      }
    ]
  });
  assert.equal(upstreamUrl, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(upstreamOptions.headers["x-goog-api-key"], apiKey);
  assert.doesNotMatch(JSON.stringify(result), /diagnostic-test-key|must not be returned/);
});

test("GET /api/ai/diagnostics/models does not call Google when server API key is missing", async (t) => {
  let upstreamCalled = false;
  const baseUrl = await startTestServer(t, {}, {
    getApiKey: () => "",
    fetchImpl: async () => {
      upstreamCalled = true;
      throw new Error("Upstream request should not be sent.");
    }
  });

  const response = await fetch(`${baseUrl}/api/ai/diagnostics/models`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "O diagnóstico de modelos não está configurado."
  });
  assert.equal(upstreamCalled, false);
});

test("POST /api/ai/analyze accepts a base64 data URL and returns a description", async (t) => {
  let receivedImage;
  const service = new AiAnalysisService({
    async describeImage(image) {
      receivedImage = image;
      return "Uma mesa está à frente.";
    }
  });
  const baseUrl = await startTestServer(t, service);
  const dataUrl = `data:image/png;base64,${PNG_IMAGE.toString("base64")}`;

  const response = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl: dataUrl })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    description: "Uma mesa está à frente."
  });
  assert.equal(receivedImage.mimeType, "image/png");
  assert.deepEqual(receivedImage.buffer, PNG_IMAGE);
});

test("successful analysis logs each stage and only request sizes", async (t) => {
  const service = new AiAnalysisService({
    async describeImage() {
      return "Uma mesa está à frente.";
    }
  });
  const baseUrl = await startTestServer(t, service);
  const originalConsoleInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));

  try {
    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG_IMAGE
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      description: "Uma mesa está à frente."
    });
  } finally {
    console.info = originalConsoleInfo;
  }

  assert.ok(logs.includes("[AI] request received"));
  assert.ok(logs.includes("[AI] content-type=image/png"));
  assert.ok(logs.includes("[AI] body/image size=body=9 bytes image=9 bytes"));
  assert.ok(logs.includes("[AI] calling analysis service"));
  assert.ok(logs.includes("[GEMINI] success"));
  assert.doesNotMatch(logs.join("\n"), new RegExp(PNG_IMAGE.toString("base64")));
});

test("POST /api/ai/analyze accepts a raw image and rejects invalid input", async (t) => {
  const service = new AiAnalysisService({
    async describeImage() {
      return "Descrição.";
    }
  });
  const baseUrl = await startTestServer(t, service);
  const imageResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: PNG_IMAGE
  });
  assert.equal(imageResponse.status, 200);

  const invalidResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl: "data:image/jpeg;base64,aGVsbG8=" })
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), {
    success: false,
    message: "Não foi possível analisar a imagem."
  });
});

test("POST /api/ai/analyze extracts a raw App Inventor PostFile image with a form content type", async (t) => {
  let receivedImage;
  const service = new AiAnalysisService({
    async describeImage(image) {
      receivedImage = image;
      return "Uma imagem foi analisada.";
    }
  });
  const baseUrl = await startTestServer(t, service);
  const originalConsoleInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));

  try {
    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: PNG_IMAGE
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      description: "Uma imagem foi analisada."
    });
  } finally {
    console.info = originalConsoleInfo;
  }

  assert.equal(receivedImage.mimeType, "image/png");
  assert.deepEqual(receivedImage.buffer, PNG_IMAGE);
  assert.ok(logs.includes("[AI] content-type=application/x-www-form-urlencoded"));
  assert.ok(logs.includes("[AI] image extracted size=9 bytes mime=image/png"));
  assert.doesNotMatch(logs.join("\n"), new RegExp(PNG_IMAGE.toString("base64")));
});

test("POST /api/ai/ask-image accepts JPEG, PNG, and WebP images from App Inventor", async (t) => {
  const cases = [
    { mimeType: "image/jpeg", image: JPEG_IMAGE },
    { mimeType: "image/png", image: PNG_IMAGE },
    { mimeType: "image/webp", image: WEBP_IMAGE }
  ];

  for (const { mimeType, image } of cases) {
    await t.test(mimeType, async (subtest) => {
      let received;
      const service = new AiAnalysisService({
        async answerQuestion(receivedImage, question) {
          received = { image: receivedImage, question };
          return "Resposta sobre a foto.";
        }
      });
      const baseUrl = await startTestServer(subtest, service);
      const question = "Me diga o que está escrito";
      const url = new URL("/api/ai/ask-image", baseUrl);
      url.searchParams.set("question", question);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: image
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        success: true,
        answer: "Resposta sobre a foto."
      });
      assert.equal(received.image.mimeType, mimeType);
      assert.deepEqual(received.image.buffer, image);
      assert.equal(received.question, question);
    });
  }
});

test("POST /api/ai/ask-image rejects missing or invalid questions and invalid images", async (t) => {
  const service = new AiAnalysisService({
    async answerQuestion() {
      return "Não deveria ser chamado.";
    }
  });
  const baseUrl = await startTestServer(t, service);

  const missingQuestion = await fetch(`${baseUrl}/api/ai/ask-image`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: PNG_IMAGE
  });
  assert.equal(missingQuestion.status, 400);

  const invalidImageUrl = new URL("/api/ai/ask-image", baseUrl);
  invalidImageUrl.searchParams.set("question", "O que aparece?");
  const invalidImage = await fetch(invalidImageUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: Buffer.from("not an image")
  });
  assert.equal(invalidImage.status, 400);
  assert.deepEqual(await invalidImage.json(), {
    success: false,
    message: "Não foi possível analisar a imagem."
  });
});

test("POST /api/ai/ask-image rejects images larger than 5 MiB", async (t) => {
  const service = new AiAnalysisService({
    async answerQuestion() {
      throw new Error("Oversized image should not reach Gemini.");
    }
  });
  const baseUrl = await startTestServer(t, service);
  const url = new URL("/api/ai/ask-image", baseUrl);
  url.searchParams.set("question", "O que aparece?");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: Buffer.alloc(MAX_IMAGE_BYTES + 1)
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "Não foi possível analisar a imagem."
  });
});

test("POST /api/ai/ask-image hides Gemini error details and does not log private content", async (t) => {
  const internalResponse = "private Gemini response with personal information";
  const service = new AiAnalysisService({
    async answerQuestion() {
      const error = new Error(internalResponse);
      error.upstreamStatus = 400;
      throw error;
    }
  });
  const baseUrl = await startTestServer(t, service);
  const originalConsoleInfo = console.info;
  const originalConsoleError = console.error;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  const url = new URL("/api/ai/ask-image", baseUrl);
  url.searchParams.set("question", "Pergunta privada");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: PNG_IMAGE
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      success: false,
      message: "Não foi possível analisar a imagem."
    });
  } finally {
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
  }

  assert.doesNotMatch(logs.join("\n"), /private Gemini response|Pergunta privada/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(PNG_IMAGE.toString("base64")));
});

test("POST /api/ai/analyze returns the standard error when no provider key is configured", async (t) => {
  const service = new AiAnalysisService(new GeminiVisionProvider({ apiKey: "" }));
  const baseUrl = await startTestServer(t, service);
  const response = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: PNG_IMAGE
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "Não foi possível analisar a imagem."
  });
});

test("POST /api/ai/analyze returns a controlled message when Gemini quota is exceeded", async (t) => {
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async text() {
        return '{"error":{"message":"Quota exceeded"}}';
      }
    })
  });
  const service = new AiAnalysisService(provider);
  const baseUrl = await startTestServer(t, service);
  const response = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: PNG_IMAGE
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "A IA está temporariamente indisponível. Tente novamente mais tarde."
  });
});

test("Gemini HTTP errors do not log the response body", async (t) => {
  const apiKey = "secret-test-api-key";
  let requestCount = 0;
  const provider = new GeminiVisionProvider({
    apiKey,
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: 403,
        async text() {
          return JSON.stringify({
            error: {
              message: `Invalid key ${apiKey}`,
              description: "Resposta potencialmente pessoal."
            }
          });
        }
      };
    }
  });
  const baseUrl = await startTestServer(t, new AiAnalysisService(provider));
  const originalConsoleError = console.error;
  const originalConsoleInfo = console.info;
  const logMessages = [];
  console.error = (...args) => logMessages.push(args.join(" "));
  console.info = (...args) => logMessages.push(args.join(" "));

  try {
    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG_IMAGE
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      success: false,
      message: "Não foi possível analisar a imagem."
    });
  } finally {
    console.error = originalConsoleError;
    console.info = originalConsoleInfo;
  }

  assert.ok(logMessages.includes("[GEMINI] tentando modelo=gemini-3.8-flash"));
  assert.ok(logMessages.includes("[GEMINI] modelo=gemini-3.8-flash status=403"));
  assert.ok(logMessages.includes("[GEMINI ERROR] status=403"));
  assert.equal(requestCount, 1);
  assert.ok(logMessages.some((message) => message.startsWith("[AI SERVICE ERROR]")));
  const loggedDiagnostics = logMessages.join("\n");
  assert.doesNotMatch(loggedDiagnostics, /Resposta potencialmente pessoal/);
  assert.doesNotMatch(loggedDiagnostics, /Invalid key/);
  assert.doesNotMatch(loggedDiagnostics, new RegExp(apiKey));
  assert.doesNotMatch(loggedDiagnostics, new RegExp(PNG_IMAGE.toString("base64")));
});

test("Gemini logs response status after receiving a successful response", async () => {
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ output_text: "Descrição de teste." });
      }
    })
  });
  const originalConsoleInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));

  try {
    const description = await provider.describeImage({
      buffer: PNG_IMAGE,
      mimeType: "image/png"
    });
    assert.equal(description, "Descrição de teste.");
  } finally {
    console.info = originalConsoleInfo;
  }

  assert.equal(logs[0], "[GEMINI] tentando modelo=gemini-3.8-flash");
  assert.match(logs[1], /^\[GEMINI\] request finished in \d+ ms status=200$/);
  assert.equal(logs[2], "[GEMINI] modelo=gemini-3.8-flash status=200");
  assert.equal(logs[3], "[GEMINI] análise concluída com modelo=gemini-3.8-flash");
});

test("Gemini extracts unique text from all Interactions response steps", async () => {
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async () => geminiResponse(200, {
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            { type: "text", text: "  Há uma mesa junto à janela.  " },
            { type: "image", text: "não deve ser incluído" },
            { type: "text", text: "Uma cadeira está ao lado da mesa." }
          ]
        },
        {
          type: "model_output",
          content: [
            { type: "text", text: "Há uma mesa junto à janela." },
            { type: "text", text: "A parede é branca." }
          ]
        }
      ]
    })
  });

  const description = await provider.describeImage({
    buffer: PNG_IMAGE,
    mimeType: "image/png"
  });

  assert.equal(
    description,
    "Há uma mesa junto à janela.\nUma cadeira está ao lado da mesa.\nA parede é branca."
  );
});

test("Gemini supports the existing output_text and outputs response formats", async () => {
  const responses = [
    {
      output_text: "Descrição do formato legado."
    },
    {
      outputs: [
        {
          content: [
            { type: "text", text: "Primeiro trecho." },
            { type: "image", text: "ignorado" }
          ]
        },
        {
          content: [
            { type: "text", text: "Segundo trecho." }
          ]
        }
      ]
    }
  ];

  for (const expected of [
    "Descrição do formato legado.",
    "Primeiro trecho.\nSegundo trecho."
  ]) {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async () => geminiResponse(200, responses.shift())
    });
    assert.equal(
      await provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
      expected
    );
  }
});

test("Gemini errors when a successful response has no supported text output", async () => {
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async () => geminiResponse(200, {
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            { type: "image", text: "not text" },
            { type: "text", image: "no text field" }
          ]
        }
      ]
    })
  });

  await assert.rejects(
    () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
    (error) =>
      error.message === "Gemini API não retornou uma descrição." &&
      error.upstreamStatus === 200
  );
});

test("Gemini uses gemini-3.8-flash directly when it succeeds", async () => {
  const requestedModels = [];
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      requestedModels.push(JSON.parse(options.body).model);
      return geminiResponse(200, { output_text: "Descrição pelo modelo principal." });
    }
  });

  const description = await provider.describeImage({
    buffer: PNG_IMAGE,
    mimeType: "image/png"
  });

  assert.equal(description, "Descrição pelo modelo principal.");
  assert.deepEqual(requestedModels, ["gemini-3.8-flash"]);
});

test("Gemini retries primary-model 503 with gemini-3.7-flash", async () => {
  const requests = [];
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return requests.length === 1
          ? geminiResponse(503, { error: { message: "Primary model unavailable" } })
          : geminiResponse(200, { output_text: "Descrição pelo fallback." });
      }
    });

    const description = await provider.describeImage({
      buffer: PNG_IMAGE,
      mimeType: "image/png"
    });

    assert.equal(description, "Descrição pelo fallback.");
  } finally {
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
  }

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ body }) => body.model), [
    "gemini-3.8-flash",
    "gemini-3.7-flash"
  ]);
  assert.ok(requests.every(({ url }) =>
    url === "https://generativelanguage.googleapis.com/v1beta/interactions"
  ));
  assert.ok(requests.every(({ body }) =>
    body.input[1].data === PNG_IMAGE.toString("base64") &&
    body.input[1].mime_type === "image/png"
  ));
  assert.ok(requests.every(({ options }) =>
    options.method === "POST" &&
    options.headers["Content-Type"] === "application/json" &&
    options.headers["x-goog-api-key"] === "test-key" &&
    options.signal
  ));
  assert.ok(logs.includes("[GEMINI] modelo=gemini-3.8-flash status=503"));
  assert.ok(logs.includes("[GEMINI] modelo=gemini-3.8-flash indisponível, tentando próximo"));
});

test("Gemini retries primary-model timeout with gemini-3.7-flash", async () => {
  const requestedModels = [];
  const timeoutValues = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    timeoutValues.push(milliseconds);
    return AbortSignal.abort(Object.assign(new Error("Timed out"), { name: "TimeoutError" }));
  };

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        const model = JSON.parse(options.body).model;
        requestedModels.push(model);
        if (model === "gemini-3.8-flash") {
          throw options.signal.reason;
        }
        return geminiResponse(200, { output_text: "Descrição pelo fallback." });
      }
    });

    const description = await provider.describeImage({
      buffer: PNG_IMAGE,
      mimeType: "image/png"
    });
    assert.equal(description, "Descrição pelo fallback.");
    assert.deepEqual(requestedModels, ["gemini-3.8-flash", "gemini-3.7-flash"]);
    assert.deepEqual(timeoutValues, [8_000, 8_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("Gemini advances from two temporarily unavailable models to gemini-3.6-flash", async () => {
  const requestedModels = [];
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        const model = JSON.parse(options.body).model;
        requestedModels.push(model);
        if (model !== "gemini-3.6-flash") {
          return geminiResponse(503, { error: { message: "Model unavailable" } });
        }
        return geminiResponse(200, { output_text: "Descrição pelo segundo fallback." });
      }
    });

    const description = await provider.describeImage({
      buffer: PNG_IMAGE,
      mimeType: "image/png"
    });

    assert.equal(description, "Descrição pelo segundo fallback.");
  } finally {
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(requestedModels, [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash"
  ]);
  assert.ok(logs.includes("[GEMINI] modelo=gemini-3.8-flash indisponível, tentando próximo"));
  assert.ok(logs.includes("[GEMINI] modelo=gemini-3.7-flash indisponível, tentando próximo"));
});

test("Gemini stops after four temporary failures", async () => {
  const requestedModels = [];
  const originalConsoleWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(" "));
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      requestedModels.push(JSON.parse(options.body).model);
      return geminiResponse(503, { error: { message: "Model unavailable" } });
    }
  });

  try {
    await assert.rejects(
      () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
      (error) => error.upstreamStatus === 503
    );
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(requestedModels, [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite"
  ]);
  assert.equal(requestedModels.length, 4);
  assert.ok(logs.includes("[GEMINI] nenhum modelo disponível"));
});

test("Gemini stops after the first 429 and logs the rate limit without trying fallbacks", async () => {
  const requestedModels = [];
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        requestedModels.push(JSON.parse(options.body).model);
        return geminiResponse(429, { error: { message: "Quota exceeded" } });
      }
    });

    await assert.rejects(
      () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
      (error) => error.upstreamStatus === 429
    );
  } finally {
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(requestedModels, ["gemini-3.8-flash"]);
  assert.ok(logs.includes("[GEMINI] modelo=gemini-3.8-flash status=429"));
  assert.ok(logs.includes("[GEMINI] quota/rate limit detectado no modelo=gemini-3.8-flash"));
  assert.ok(logs.includes("[GEMINI] nenhum modelo disponível"));
});

test("Gemini falls back after a model-scoped 429 and logs the successful Flash-Lite model", async () => {
  const requestedModels = [];
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        const model = JSON.parse(options.body).model;
        requestedModels.push(model);
        if (model === "gemini-3.6-flash") {
          return geminiResponse(429, {
            error: {
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                  violations: [
                    { subject: "project:123;model:gemini-3.6-flash" }
                  ]
                }
              ]
            }
          });
        }
        if (model !== "gemini-3.5-flash-lite") {
          return geminiResponse(503, { error: { message: "Model unavailable" } });
        }
        return geminiResponse(200, { output_text: "Descrição pelo Flash-Lite." });
      }
    });

    assert.equal(
      await provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
      "Descrição pelo Flash-Lite."
    );
  } finally {
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(requestedModels, [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite"
  ]);
  assert.ok(logs.includes("[GEMINI] quota/rate limit detectado no modelo=gemini-3.6-flash"));
  assert.ok(logs.includes("[GEMINI] modelo=gemini-3.6-flash indisponível, tentando próximo"));
  assert.ok(logs.includes("[GEMINI] análise concluída com modelo=gemini-3.5-flash-lite"));
});

test("Gemini does not switch models for permanent HTTP errors", async (t) => {
  const models = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite"
  ];
  for (const status of [400, 401, 403, 404, 429]) {
    for (let failingIndex = 0; failingIndex < models.length; failingIndex += 1) {
      await t.test(`HTTP ${status} from ${models[failingIndex]}`, async () => {
        const requestedModels = [];
        const provider = new GeminiVisionProvider({
          apiKey: "test-key",
          fetchImpl: async (_url, options) => {
            const model = JSON.parse(options.body).model;
            requestedModels.push(model);
            if (requestedModels.length - 1 < failingIndex) {
              return geminiResponse(503, { error: { message: "Temporarily unavailable" } });
            }
            return geminiResponse(status, { error: { message: "Permanent error" } });
          }
        });

        await assert.rejects(
          () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
          (error) => error.upstreamStatus === status
        );
        assert.deepEqual(requestedModels, models.slice(0, failingIndex + 1));
      });
    }
  }
});

test("Gemini request uses an 8-second timeout and logs elapsed time", async () => {
  const originalTimeout = AbortSignal.timeout;
  const originalConsoleInfo = console.info;
  const logs = [];
  let timeoutMs;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return originalTimeout.call(AbortSignal, milliseconds);
  };
  console.info = (...args) => logs.push(args.join(" "));

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ output_text: "Descrição de teste." });
        }
      })
    });

    await provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" });
  } finally {
    AbortSignal.timeout = originalTimeout;
    console.info = originalConsoleInfo;
  }

  assert.equal(timeoutMs, 8_000);
  assert.match(
    logs[1],
    /^\[GEMINI\] request finished in \d+ ms status=200$/
  );
});

test("Gemini timeout logs elapsed milliseconds without exposing request data", async () => {
  const originalTimeout = AbortSignal.timeout;
  const originalConsoleError = console.error;
  const logs = [];
  let timeoutMs;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return AbortSignal.abort(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError"
      })
    );
  };
  console.error = (...args) => logs.push(args.join(" "));

  try {
    const provider = new GeminiVisionProvider({
      apiKey: "secret-test-api-key",
      fetchImpl: async (_url, options) => {
        throw options.signal.reason;
      }
    });

    await assert.rejects(
      () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
      /Falha de comunicação/
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
    console.error = originalConsoleError;
  }

  assert.equal(timeoutMs, 8_000);
  assert.match(logs[0], /^\[GEMINI ERROR\] timeout after \d+ ms model=gemini-3\.8-flash$/);
  assert.doesNotMatch(logs.join("\n"), /secret-test-api-key/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(PNG_IMAGE.toString("base64")));
});

test("image validation enforces the 5 MiB limit", () => {
  const oversizedImage = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
  assert.throws(
    () => parseImageRequest({ body: oversizedImage, is: () => "image/png" }),
    (error) => error.status === 413
  );
});

test("Gemini provider sends the image and accessibility prompt to the configured model", async () => {
  let requestUrl;
  let requestOptions;
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ output_text: "Uma placa informa a saída." });
        }
      };
    }
  });

  const description = await provider.describeImage({
    buffer: PNG_IMAGE,
    mimeType: "image/png"
  });

  assert.equal(description, "Uma placa informa a saída.");
  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(requestOptions.headers["x-goog-api-key"], "test-key");
  const requestBody = JSON.parse(requestOptions.body);
  assert.equal(requestBody.model, "gemini-3.8-flash");
  assert.equal(requestBody.input[1].mime_type, "image/png");
  assert.equal(requestBody.input[1].data, PNG_IMAGE.toString("base64"));
  assert.match(requestBody.input[0].text, /português brasileiro/);
  assert.match(requestBody.input[0].text, /cores relevantes/);
  assert.match(requestBody.input[0].text, /Não invente/);
});

test("Gemini provider includes the user's question with the image", async () => {
  let requestOptions;
  const provider = new GeminiVisionProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return geminiResponse(200, { output_text: "Está escrito 'Saída'." });
    }
  });
  const question = "Me diga o que está escrito";

  assert.equal(
    await provider.answerQuestion({ buffer: PNG_IMAGE, mimeType: "image/png" }, question),
    "Está escrito 'Saída'."
  );
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.input[1].data, PNG_IMAGE.toString("base64"));
  assert.equal(body.input[1].mime_type, "image/png");
  assert.match(body.input[0].text, /responda especificamente à pergunta/);
  assert.match(body.input[0].text, new RegExp(question));
  assert.match(body.input[0].text, /não invente/i);
});

test("Gemini provider fails explicitly when AI_API_KEY is missing", async () => {
  const provider = new GeminiVisionProvider({ apiKey: "" });

  await assert.rejects(
    () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
    (error) => error.code === "AI_API_KEY_MISSING"
  );
});

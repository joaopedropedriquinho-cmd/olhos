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

async function startTestServer(t, aiAnalysisService) {
  const app = express();
  app.use("/api/ai", createAiRouter(aiAnalysisService));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

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

test("Gemini HTTP errors are logged with status and sanitized response body", async (t) => {
  const apiKey = "secret-test-api-key";
  const provider = new GeminiVisionProvider({
    apiKey,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async text() {
        return JSON.stringify({
          error: {
            message: `Invalid key ${apiKey}`,
            echoedImage: PNG_IMAGE.toString("base64")
          }
        });
      }
    })
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

  assert.ok(logMessages.includes("[GEMINI] request starting"));
  assert.ok(logMessages.includes("[GEMINI] response status=403"));
  assert.ok(logMessages.includes("[GEMINI ERROR] status=403"));
  assert.ok(logMessages.some((message) => message.includes("[GEMINI ERROR] body=")));
  assert.ok(logMessages.some((message) => message.startsWith("[AI SERVICE ERROR]")));
  const loggedDiagnostics = logMessages.join("\n");
  assert.match(loggedDiagnostics, /Invalid key \[API_KEY_REDACTED\]/);
  assert.match(loggedDiagnostics, /\[IMAGE_DATA_REDACTED\]/);
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

  assert.deepEqual(logs, [
    "[GEMINI] request starting",
    "[GEMINI] response status=200"
  ]);
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

test("Gemini provider fails explicitly when AI_API_KEY is missing", async () => {
  const provider = new GeminiVisionProvider({ apiKey: "" });

  await assert.rejects(
    () => provider.describeImage({ buffer: PNG_IMAGE, mimeType: "image/png" }),
    (error) => error.code === "AI_API_KEY_MISSING"
  );
});

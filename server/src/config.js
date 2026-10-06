const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin, requestHost) {
  if (!origin || configuredOrigins.includes(origin)) {
    return true;
  }

  try {
    if (requestHost && new URL(origin).host.toLowerCase() === requestHost.toLowerCase()) {
      return true;
    }
  } catch {
    return false;
  }

  if (process.env.NODE_ENV === "production") {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    return ["localhost", "127.0.0.1"].includes(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: "0.0.0.0",
  isAllowedOrigin
};

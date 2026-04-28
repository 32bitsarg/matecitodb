require("dotenv").config();

const path = require("path");
const fastify = require("fastify")({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  trustProxy: true,
  bodyLimit: 1024 * 1024,
  requestTimeout: 60_000,
});

const config = require("../lib/hosting/config");
const { ensureHostingTables } = require("../lib/hosting/schema");

fastify.register(require("@fastify/jwt"), {
  secret: process.env.JWT_SECRET,
});

fastify.addContentTypeParser("application/json", { parseAs: "string" }, function (_req, body, done) {
  try {
    const raw = body || "";
    done(null, raw ? JSON.parse(raw) : {});
  } catch (err) {
    done(err);
  }
});

fastify.addHook("preValidation", async (req) => {
  if (typeof req.body === "string") {
    req.rawBody = req.body;
    req.body = req.body ? JSON.parse(req.body) : {};
    return;
  }
  req.rawBody = req.rawBody || (req.body ? JSON.stringify(req.body) : "");
});

fastify.get("/health", async () => ({
  ok: true,
  service: "matecito-hosting",
  api_version: config.serviceApiVersion,
}));

fastify.register(require("./routes"));

async function start() {
  await ensureHostingTables();
  await fastify.listen({
    host: "0.0.0.0",
    port: config.port,
  });
}

start().catch(err => {
  fastify.log.error(err);
  process.exit(1);
});

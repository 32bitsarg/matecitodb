require("dotenv").config();

const crypto = require("crypto");

// ─── Validate required env vars ───────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET env var is required and must be at least 32 characters");
}

const fastify = require("fastify")({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    transport: process.env.NODE_ENV !== "production" ? {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    } : undefined,
  },
  trustProxy: true,
  genReqId: () => crypto.randomUUID(),
});

const { db }                    = require("./lib/matecito");
const { getProjectBySubdomain } = require("./lib/subdomain-cache");
const { startRealtimeListener } = require("./lib/v2/realtime");
const { setRedisClient }        = require("./lib/v2/permissions");
const { runMigrations }         = require("./lib/v2/migrations");
const { startScheduler }        = require("./lib/v2/scheduler");

const START_TIME = Date.now();

const DOMAIN = process.env.DOMAIN || "matecito.dev";
const PLATFORM_HOST = process.env.PLATFORM_HOST || `api.${DOMAIN}`;

//
// ─── REWRITE HELPER ─────────────────────────────────────────
//

function rewritePublicPath(pathname) {
  if (!pathname) return pathname;

  // ya es interna
  if (pathname.startsWith("/api/v1/project")) {
    return pathname;
  }

  // AUTH
  if (pathname.startsWith("/auth")) {
    return `/api/v1/project${pathname}`;
  }

  // REST estilo Supabase
  if (pathname.startsWith("/rest/v1")) {
    const rest = pathname.replace("/rest/v1", "");
    return `/api/v1/project${rest}`;
  }

  // STORAGE
  if (pathname.startsWith("/storage")) {
    return `/api/v1/project${pathname}`;
  }

  // REALTIME
  if (pathname.startsWith("/realtime")) {
    return `/api/v1/project${pathname}`;
  }

  // fallback
  return `/api/v1/project${pathname}`;
}

//
// ─── SWAGGER ────────────────────────────────────────────────
//

fastify.register(require("@fastify/swagger"), {
  openapi: {
    info: {
      title: "Matebase API",
      description: "Backend-as-a-service API — v2",
      version: "2.0.0",
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey:     { type: "apiKey", in: "header", name: "x-matecito-key" },
      },
    },
    security: [{ bearerAuth: [] }, { apiKey: [] }],
  },
});

fastify.register(require("@fastify/swagger-ui"), {
  routePrefix: "/docs",
  uiConfig: { deepLinking: true },
});

//
// ─── RATE LIMIT ─────────────────────────────────────────────
//

fastify.register(require("@fastify/rate-limit"), {
  global:     false, // Only routes with config.rateLimit are limited
  redis:      process.env.REDIS_URL ? (() => {
    try { return require("./lib/v2/redis").redis; } catch { return null; }
  })() : null,
  keyGenerator: (req) => {
    const projectId = req.resolvedProject?.id ?? req.params?.projectId;
    // Try to extract userId from JWT without full verify (rate limit key only — auth still in preHandler)
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      try {
        const payload = JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString());
        if (payload?.sub && projectId) return `${projectId}:user:${payload.sub}`;
      } catch { /* ignore — fall through to IP */ }
    }
    return projectId ? `${projectId}:${req.ip}` : req.ip;
  },
  errorResponseBuilder: (_req, context) => ({
    error:       "Too many requests",
    code:        "RATE_001",
    retry_after: context.after,
  }),
});

//
// ─── CORRELATION ID ─────────────────────────────────────────
//

fastify.addHook("onRequest", async (req, reply) => {
  const id = req.headers["x-request-id"] || req.id;
  req.requestId = id;
  reply.header("x-request-id", id);
});

//
// ─── DEBUG LOG ──────────────────────────────────────────────
//

fastify.addHook("onRequest", async (req, reply) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();

  const originalUrl = req.raw.url;

  fastify.log.info({
    step: "REQUEST_IN",
    method: req.method,
    host,
    url: originalUrl,
  });

  const isInternalRoute =
    originalUrl === "/" ||
    originalUrl.startsWith("/health") ||
    host === PLATFORM_HOST ||
    host === "localhost" ||
    host === "127.0.0.1";

  if (isInternalRoute) {
    fastify.log.info({
      step: "SKIP_INTERNAL",
      reason: "internal route",
    });
    return;
  }

  const domainSuffix = `.${DOMAIN}`;
  if (!host.endsWith(domainSuffix)) {
    fastify.log.info({
      step: "SKIP",
      reason: "not matching domain",
    });
    return;
  }

  const subdomain = host.slice(0, -domainSuffix.length);

  const VALID_SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (!subdomain || subdomain === "www" || subdomain === "api" || !VALID_SUBDOMAIN.test(subdomain)) {
    fastify.log.info({
      step: "SKIP",
      reason: "invalid subdomain",
      subdomain,
    });
    return;
  }

  try {
    //
    // ─── RESOLVE PROJECT ────────────────────────────────────
    //

    const project = await getProjectBySubdomain(subdomain);

    if (!project) {
      fastify.log.error({
        step: "PROJECT_NOT_FOUND",
        subdomain,
      });
      return reply.code(404).send({ error: "Project not found" });
    }

    req.resolvedProject = project;

    //
    // ─── REWRITE ────────────────────────────────────────────
    //

    const [pathname, query = ""] = originalUrl.split("?");

    const rewrittenPath = rewritePublicPath(pathname);
    const finalUrl = query ? `${rewrittenPath}?${query}` : rewrittenPath;

    req.url = finalUrl;
    req.raw.url = finalUrl;

    //
    // ─── LOG FINAL ─────────────────────────────────────────
    //

    fastify.log.info({
      step: "REWRITE_OK",
      subdomain,
      projectId: project.id,
      schema: project.schema_name,
      originalUrl,
      rewrittenUrl: finalUrl,
    });

  } catch (err) {
    fastify.log.error({
      step: "ERROR",
      error: err.message,
    });
    return reply.code(500).send({ error: "Internal error" });
  }
});

//
// ─── CORS ───────────────────────────────────────────────────
//
// - Rutas de plataforma (api.matecito.dev): solo orígenes de PLATFORM_CORS_ORIGIN.
// - Rutas de proyecto (subdominio): usa allowed_origins del proyecto.
//   Si está vacío/null → permite todo (comportamiento intencional del producto).
//

const PLATFORM_CORS_ORIGINS = process.env.PLATFORM_CORS_ORIGIN
  ? process.env.PLATFORM_CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

fastify.addHook("onRequest", async (req, reply) => {
  const origin     = req.headers.origin || "";
  const host       = (req.headers.host || "").split(":")[0].toLowerCase();
  const isPlatform = host === PLATFORM_HOST || host === "localhost" || host === "127.0.0.1";

  let allowOrigin = null;

  if (isPlatform) {
    // Plataforma: si no hay lista configurada, permite cualquier origen en dev
    if (PLATFORM_CORS_ORIGINS.length === 0 || PLATFORM_CORS_ORIGINS.includes(origin)) {
      allowOrigin = origin || "*";
    }
  } else {
    // Proyecto: usa la configuración del proyecto cacheada
    const allowed = req.resolvedProject?.allowed_origins;
    if (!allowed || allowed.length === 0) {
      // Sin restricción configurada → permite todo
      allowOrigin = origin || "*";
    } else if (origin && allowed.includes(origin)) {
      allowOrigin = origin;
    }
    // Si origin no está en la lista → allowOrigin queda null → sin headers CORS
  }

  if (allowOrigin) {
    reply.header("Access-Control-Allow-Origin",      allowOrigin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Methods",     "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers",     "Content-Type, Authorization, x-matecito-key");
    reply.header("Access-Control-Max-Age",           "86400");
  }

  if (req.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

//
// ─── SDK HEADERS ────────────────────────────────────────────
//

const _storageCache = new Map(); // projectId → { used, quota, exp }

fastify.addHook("onSend", async (req, reply) => {
  reply.header("X-Matecito-Version", "2");

  const projectId = req.resolvedProject?.id ?? req.params?.projectId;
  if (!projectId) return;

  try {
    const now    = Date.now();
    const cached = _storageCache.get(projectId);

    let usedBytes, quotaMb;
    if (cached && cached.exp > now) {
      usedBytes = cached.used;
      quotaMb   = cached.quota;
    } else {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(f.size), 0)::bigint AS used, COALESCE(p.storage_quota_mb, 250) AS quota
         FROM projects p LEFT JOIN files f ON f.project_id = p.id
         WHERE p.id = $1 GROUP BY p.storage_quota_mb`,
        [projectId]
      );
      if (rows[0]) {
        usedBytes = Number(rows[0].used);
        quotaMb   = Number(rows[0].quota);
        _storageCache.set(projectId, { used: usedBytes, quota: quotaMb, exp: now + 60_000 });
      }
    }

    if (usedBytes !== undefined) {
      reply.header("X-Storage-Used-MB",  (usedBytes / 1024 / 1024).toFixed(2));
      reply.header("X-Storage-Quota-MB", String(quotaMb));
    }
  } catch { /* non-critical */ }
});

//
// ─── RESPONSE LOG ───────────────────────────────────────────
//

fastify.addHook("onResponse", async (req, reply) => {
  fastify.log.info({
    step: "RESPONSE",
    method: req.method,
    url: req.raw.url,
    status: reply.statusCode,
  });
});

//
// ─── ROUTES ─────────────────────────────────────────────────
//

fastify.get("/", async () => ({ status: "ok" }));

fastify.get("/health", async (req, reply) => {
  const checks = {};

  // DB
  try {
    await db.query("SELECT 1");
    checks.db = {
      status:   "up",
      pool: {
        total:   db.totalCount,
        idle:    db.idleCount,
        waiting: db.waitingCount,
      },
    };
  } catch (err) {
    checks.db = { status: "down", error: err.message };
  }

  // Redis (optional)
  let redisStatus = "not_configured";
  if (process.env.REDIS_URL) {
    try {
      const { redis } = require("./lib/v2/redis");
      if (redis) {
        await redis.ping();
        redisStatus = "up";
      }
    } catch {
      redisStatus = "down";
    }
  }
  checks.redis = redisStatus;

  const uptimeMs  = Date.now() - START_TIME;
  const isHealthy = checks.db.status === "up";

  return reply.code(isHealthy ? 200 : 503).send({
    status:    isHealthy ? "up" : "degraded",
    uptime_ms: uptimeMs,
    version:   require("./package.json").version,
    checks,
  });
});

fastify.register(require("@fastify/jwt"), {
  secret: process.env.JWT_SECRET,
});

// ─── v1 routes ────────────────────────────────────────────────────────────────
fastify.register(require("./routes/platform"), {
  prefix: "/api/v1/platform",
});

fastify.register(require("./routes/project"), {
  prefix: "/api/v1/project",
});

// ─── v2 routes ────────────────────────────────────────────────────────────────
fastify.register(require("./routes/v2/platform"), {
  prefix: "/api/v2/platform",
});

fastify.register(require("./routes/v2/project"), {
  prefix: "/api/v2/project",
});

//
// ─── ERROR HANDLER ──────────────────────────────────────────
//

fastify.setErrorHandler((error, req, reply) => {
  fastify.log.error({
    step: "ERROR_HANDLER",
    error: error.message,
  });

  return reply.code(error.statusCode || 500).send({
    error: error.message || "Internal Server Error",
  });
});

//
// ─── START ──────────────────────────────────────────────────
//

const start = async () => {
  try {
    // ── Redis (optional — for distributed permission cache) ──────────────────
    if (process.env.REDIS_URL) {
      try {
        const { redis } = require("./lib/v2/redis");
        if (redis) {
          setRedisClient(redis);
          fastify.log.info("Redis connected — using distributed permission cache");
        }
      } catch (err) {
        fastify.log.warn({ msg: "Redis init failed, using in-memory cache", error: err.message });
      }
    }

    // ── Platform migrations ──────────────────────────────────────────────────
    try {
      await runMigrations();
      fastify.log.info("Platform migrations up to date");
    } catch (err) {
      fastify.log.warn({ msg: "Platform migrations failed (non-fatal)", error: err.message });
    }

    // ── Background scheduler (cleanup jobs) ──────────────────────────────────
    startScheduler();

    // ── pg_notify realtime listener ──────────────────────────────────────────
    startRealtimeListener().catch(err => {
      fastify.log.warn({ msg: "Realtime listener failed to start", error: err.message });
    });

    const port = Number(process.env.PORT || 3000);
    await fastify.listen({ port, host: "0.0.0.0" });
    fastify.log.info(`Matecito API v2 running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

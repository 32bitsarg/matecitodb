require("dotenv").config();

const fastify = require("fastify")({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  },
  trustProxy: true,
});

const { db } = require("./lib/matecito");
const { getProjectBySubdomain } = require("./lib/subdomain-cache");

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

fastify.get("/health", async () => {
  await db.query("SELECT 1");
  return { status: "up" };
});
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET env var is required and must be at least 32 characters");
}
fastify.register(require("@fastify/jwt"), {
  secret: process.env.JWT_SECRET,
});
fastify.register(require("./routes/platform"), {
  prefix: "/api/v1/platform",
});

fastify.register(require("./routes/project"), {
  prefix: "/api/v1/project",
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
    const port = Number(process.env.PORT || 3000);
    await fastify.listen({ port, host: "0.0.0.0" });
fastify.log.info(fastify.printRoutes());
    fastify.log.info(`🚀 Matecito API running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

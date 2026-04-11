// ─── Remote Config / Feature Flags ────────────────────────────────────────────
//
// GET    /config                       → todos los configs públicos
// GET    /config/:key                  → valor de un config
// PUT    /config/:key                  → crear/actualizar
// DELETE /config/:key                  → eliminar
//
// Cache en memoria de 60s para evitar hits a DB en cada request.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
  requireProjectOrPlatformAuth,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { ensureV2Tables }    = require("../../../../lib/v2/schema");
const { apiError }          = require("../../../../lib/v2/errors");

// ── In-memory cache (60s TTL) ────────────────────────────────────────────────
const _cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL = 60_000;

function getCache(key) {
  const entry = _cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  _cache.delete(key);
  return null;
}

function setCache(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
}

function invalidateCache(schemaKey) {
  // Borrar todas las entradas de este schema
  for (const [k] of _cache) {
    if (k.startsWith(`${schemaKey}:`)) _cache.delete(k);
  }
}

async function getConfigRows(schemaName) {
  const cacheKey = `${schemaName}:_all`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { rows } = await db.query(
    `SELECT * FROM ${quoteIdent(schemaName)}._remote_config ORDER BY key`
  );

  const map = {};
  for (const row of rows) {
    map[row.key] = row;
  }

  setCache(cacheKey, map);
  return map;
}

// ── Routes ───────────────────────────────────────────────────────────────────

module.exports = async function (fastify) {
  // GET /config — listar configs públicos (auth opcional para ver todos)
  fastify.get("/config", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureV2Tables(schemaName);

    const configs = await getConfigRows(schemaName);
    const result = {};

    for (const [key, row] of Object.entries(configs)) {
      if (row.is_public || req.projectUser || req.platformUser) {
        result[key] = {
          key: row.key,
          value: row.value,
          description: row.description,
          updated_at: row.updated_at,
        };
      }
    }

    return { configs: result };
  });

  // GET /config/:key — valor de un config
  fastify.get("/config/:key", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { key }   = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureV2Tables(schemaName);

    const configs = await getConfigRows(schemaName);
    const config = configs[key];

    if (!config) return apiError(reply, "GEN_003", `Config '${key}' not found`);
    if (!config.is_public && !req.projectUser && !req.platformUser) {
      return apiError(reply, "PERM_001");
    }

    return {
      key: config.key,
      value: config.value,
      description: config.description,
      updated_at: config.updated_at,
    };
  });

  // PUT /config/:key — crear o actualizar
  fastify.put("/config/:key", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["value"],
        properties: {
          value:       { type: "object" },
          description: { type: "string" },
          is_public:   { type: "boolean" },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { key }   = req.params;
    const { value, description, is_public = true } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const updatedBy = req.projectUser?.id ?? req.platformUser?.id ?? null;

    const { rows } = await db.query(
      `INSERT INTO ${schema}._remote_config (key, value, description, is_public, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET value = $2, description = $3, is_public = $4, updated_by = $5, updated_at = NOW()
       RETURNING *`,
      [key, JSON.stringify(value), description || null, is_public, updatedBy]
    );

    invalidateCache(schemaName);

    return reply.code(200).send({
      key: rows[0].key,
      value: rows[0].value,
      description: rows[0].description,
      is_public: rows[0].is_public,
      updated_at: rows[0].updated_at,
    });
  });

  // DELETE /config/:key — eliminar
  fastify.delete("/config/:key", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { key }   = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureV2Tables(schemaName);

    const { rowCount } = await db.query(
      `DELETE FROM ${quoteIdent(schemaName)}._remote_config WHERE key = $1`,
      [key]
    );

    if (rowCount === 0) return apiError(reply, "GEN_003", `Config '${key}' not found`);

    invalidateCache(schemaName);

    return { deleted: key };
  });
};

// ─── Function Environment Variables (F1) ────────────────────────────────────
//
// GET    /functions/env          → listar keys (sin valores)
// POST   /functions/env          → crear/actualizar { key, value }
// DELETE /functions/env/:key     → eliminar

const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const crypto             = require("crypto");

const APP_SECRET = process.env.JWT_SECRET || "fallback-secret-do-not-use-in-prod";

function encryptValue(value) {
  const key = crypto.scryptSync(APP_SECRET, "function-env-salt", 32);
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptValue(encrypted) {
  const [ivHex, ...restHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = restHex.join(":");
  const key = crypto.scryptSync(APP_SECRET, "function-env-salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;

module.exports = async function (fastify) {
  // ── GET /functions/env ─────────────────────────────────────────────────
  fastify.get("/functions/env", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, key, created_at FROM ${schema}._function_env ORDER BY key`
    );

    return { env_keys: rows.map(r => ({ key: r.key, created_at: r.created_at })) };
  });

  // ── POST /functions/env ────────────────────────────────────────────────
  fastify.post("/functions/env", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key:   { type: "string", pattern: VALID_ENV_KEY.source },
          value: { type: "string", minLength: 1 },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { key, value } = req.body;

    if (!VALID_ENV_KEY.test(key)) {
      return reply.code(400).send({ error: "Invalid key. Must match: " + VALID_ENV_KEY.source, code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const encrypted = encryptValue(value);

    const { rows } = await db.query(
      `INSERT INTO ${schema}._function_env (key, value_enc)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value_enc = $2
       RETURNING id, key, created_at`,
      [key, encrypted]
    );

    return reply.code(201).send({ env_key: rows[0] });
  });

  // ── DELETE /functions/env/:key ─────────────────────────────────────────
  fastify.delete("/functions/env/:key", {
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

    const schema = quoteIdent(schemaName);
    const { rowCount } = await db.query(
      `DELETE FROM ${schema}._function_env WHERE key = $1`,
      [key]
    );

    if (rowCount === 0) return apiError(reply, "GEN_003", `Env key '${key}' not found`);

    return { deleted: key };
  });
};

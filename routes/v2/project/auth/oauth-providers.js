const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const SUPPORTED = ["google", "github"];

// Lazy-create _oauth_providers table (existing projects don't have it)
const _oauthReady = new Set();
async function ensureOAuthTable(schemaName) {
  if (_oauthReady.has(schemaName)) return;
  const s = quoteIdent(schemaName);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._oauth_providers (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider      TEXT NOT NULL UNIQUE,
      client_id     TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      enabled       BOOLEAN DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  _oauthReady.add(schemaName);
}

module.exports = async function (fastify) {
  // GET /auth/oauth-providers
  projectRoute(fastify, "GET", "/auth/oauth-providers", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureOAuthTable(schemaName);
    const s = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, provider, client_id, enabled, created_at FROM ${s}._oauth_providers ORDER BY provider`
    );
    return { providers: rows };
  });

  // POST /auth/oauth-providers
  projectRoute(fastify, "POST", "/auth/oauth-providers", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["provider", "client_id", "client_secret"],
        additionalProperties: false,
        properties: {
          provider:      { type: "string", enum: SUPPORTED },
          client_id:     { type: "string", minLength: 1 },
          client_secret: { type: "string", minLength: 1 },
          enabled:       { type: "boolean", default: true },
        },
      },
    },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const { provider, client_id, client_secret, enabled = true } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureOAuthTable(schemaName);
    const s = quoteIdent(schemaName);
    const { rows } = await db.query(
      `INSERT INTO ${s}._oauth_providers (provider, client_id, client_secret, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider) DO UPDATE
         SET client_id     = EXCLUDED.client_id,
             client_secret = CASE
               WHEN EXCLUDED.client_secret = '***UNCHANGED***'
               THEN ${s}._oauth_providers.client_secret
               ELSE EXCLUDED.client_secret
             END,
             enabled       = EXCLUDED.enabled
       RETURNING id, provider, client_id, enabled, created_at`,
      [provider, client_id, client_secret, enabled]
    );

    return reply.code(201).send({ provider: rows[0] });
  });

  // DELETE /auth/oauth-providers/:provider
  projectRoute(fastify, "DELETE", "/auth/oauth-providers/:provider", {
    preHandler: requireProjectOrPlatformAuth,
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const { provider } = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureOAuthTable(schemaName);
    const s = quoteIdent(schemaName);
    await db.query(`DELETE FROM ${s}._oauth_providers WHERE provider = $1`, [provider]);
    return { ok: true };
  });
};

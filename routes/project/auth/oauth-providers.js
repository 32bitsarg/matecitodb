const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

const SUPPORTED = ["google", "github"];

module.exports = async function (fastify) {
  // GET /auth/oauth-providers — list configured providers
  projectRoute(fastify, "GET", "/auth/oauth-providers", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s   = quoteIdent(schemaName);
    const res = await db.query(`SELECT id, provider, client_id, enabled, created_at FROM ${s}._oauth_providers ORDER BY provider`);
    return { providers: res.rows };
  });

  // POST /auth/oauth-providers — add or update a provider
  projectRoute(fastify, "POST", "/auth/oauth-providers", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const { provider, client_id, client_secret, enabled = true } = req.body ?? {};

    if (!provider || !SUPPORTED.includes(provider)) {
      return reply.code(400).send({ error: `provider must be one of: ${SUPPORTED.join(", ")}` });
    }
    if (!client_id || !client_secret) {
      return reply.code(400).send({ error: "client_id and client_secret are required" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s   = quoteIdent(schemaName);
    const res = await db.query(
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

    return reply.code(201).send({ provider: res.rows[0] });
  });

  // DELETE /auth/oauth-providers/:provider — remove a provider
  projectRoute(fastify, "DELETE", "/auth/oauth-providers/:provider", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const { provider } = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s = quoteIdent(schemaName);
    await db.query(`DELETE FROM ${s}._oauth_providers WHERE provider = $1`, [provider]);
    return { ok: true };
  });
};

const {
  db,
  quoteIdent,
  projectRoute,
  requireProjectOrPlatformAuth,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

async function resolveSchema(req) {
  const project    = req.resolvedProject;
  const projectId  = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

async function ensureTable(s) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._fcm_config (
      id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      project_id  TEXT NOT NULL,
      credentials JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

module.exports = async function (fastify) {
  // GET /notifications/firebase-config
  projectRoute(fastify, "GET", "/notifications/firebase-config", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    try {
      const { rows } = await db.query(
        `SELECT project_id, updated_at FROM ${s}._fcm_config ORDER BY updated_at DESC NULLS LAST LIMIT 1`
      );
      if (!rows[0]) return { configured: false };
      return { configured: true, project_id: rows[0].project_id, updated_at: rows[0].updated_at };
    } catch {
      return { configured: false };
    }
  });

  // PUT /notifications/firebase-config
  projectRoute(fastify, "PUT", "/notifications/firebase-config", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["credentials"],
        additionalProperties: false,
        properties: {
          credentials: { type: "object" },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);

    const { credentials } = req.body;
    if (!credentials.project_id || !credentials.private_key || !credentials.client_email) {
      return reply.code(400).send({ error: "Invalid service account: must include project_id, private_key and client_email", code: "GEN_002" });
    }

    await ensureTable(s);
    await db.query(`DELETE FROM ${s}._fcm_config`);
    await db.query(`INSERT INTO ${s}._fcm_config (project_id, credentials) VALUES ($1, $2)`, [credentials.project_id, credentials]);

    return { ok: true, project_id: credentials.project_id };
  });

  // DELETE /notifications/firebase-config
  projectRoute(fastify, "DELETE", "/notifications/firebase-config", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    try { await db.query(`DELETE FROM ${s}._fcm_config`); } catch { /* table may not exist */ }
    return { ok: true };
  });
};

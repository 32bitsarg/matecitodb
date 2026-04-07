/**
 * GET    /notifications/firebase-config  — leer si hay config (sin exponer el JSON completo)
 * PUT    /notifications/firebase-config  — guardar service account JSON
 * DELETE /notifications/firebase-config  — eliminar config
 */
const { db, quoteIdent, projectRoute, requireProjectOrPlatformAuth } = require("../../../lib/matecito");

async function resolveSchema(req) {
  const project = req.resolvedProject;
  const projectId = project?.id ?? req.params?.projectId;
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

  // GET — ¿está configurado?
  projectRoute(fastify, "GET", "/notifications/firebase-config", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    try {
      const { rows } = await db.query(`SELECT project_id, updated_at FROM ${s}._fcm_config LIMIT 1`);
      if (!rows[0]) return { configured: false };
      return { configured: true, project_id: rows[0].project_id, updated_at: rows[0].updated_at };
    } catch {
      return { configured: false };
    }
  });

  // PUT — guardar service account JSON
  projectRoute(fastify, "PUT", "/notifications/firebase-config", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { credentials } = req.body ?? {};
    if (!credentials || typeof credentials !== "object") {
      return reply.code(400).send({ error: "credentials (service account JSON object) is required" });
    }

    // Validar campos mínimos del service account
    if (!credentials.project_id || !credentials.private_key || !credentials.client_email) {
      return reply.code(400).send({ error: "Invalid service account: must include project_id, private_key and client_email" });
    }

    await ensureTable(s);

    await db.query(`
      INSERT INTO ${s}._fcm_config (project_id, credentials)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET
        project_id  = EXCLUDED.project_id,
        credentials = EXCLUDED.credentials,
        updated_at  = NOW()
    `, [credentials.project_id, credentials]);

    return { ok: true, project_id: credentials.project_id };
  });

  // DELETE — eliminar config
  projectRoute(fastify, "DELETE", "/notifications/firebase-config", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);
    try {
      await db.query(`DELETE FROM ${s}._fcm_config`);
    } catch { /* tabla no existe aún */ }
    return { ok: true };
  });
};

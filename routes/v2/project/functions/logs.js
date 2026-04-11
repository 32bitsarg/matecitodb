// ─── Function Logs (F1) ─────────────────────────────────────────────────────
//
// GET /functions/:name/logs  → últimas N ejecuciones

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.get("/functions/:name/logs", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;
    const { limit = "50", status } = req.query;

    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    // Get function ID
    const { rows: fnRows } = await db.query(
      `SELECT id FROM ${schema}._functions WHERE name = $1 LIMIT 1`,
      [name]
    );
    if (!fnRows[0]) return apiError(reply, "GEN_003", `Function '${name}' not found`);

    const where = [`function_id = $1`];
    const values = [fnRows[0].id];

    if (status) {
      values.push(status);
      where.push(`status = $${values.length}`);
    }

    const { rows } = await db.query(
      `SELECT id, status, duration_ms, result, error, invoked_by, created_at
       FROM ${schema}._function_logs
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1}`,
      [...values, limitNum]
    );

    return {
      function: name,
      logs: rows,
      total: rows.length,
    };
  });
};

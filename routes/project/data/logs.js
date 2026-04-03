const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/logs", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const page  = Math.max(1, parseInt(req.query?.page  ?? "1"));
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit ?? "100")));
    const offset = (page - 1) * limit;

    const statusFilter = req.query?.status; // e.g. "200" | "4xx" | "5xx"

    let where = "";
    const params = [];
    if (statusFilter) {
      if (statusFilter === "2xx") { where = "WHERE status_code >= 200 AND status_code < 300"; }
      else if (statusFilter === "4xx") { where = "WHERE status_code >= 400 AND status_code < 500"; }
      else if (statusFilter === "5xx") { where = "WHERE status_code >= 500"; }
      else { where = `WHERE status_code = $1`; params.push(parseInt(statusFilter)); }
    }

    const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM ${s}._logs ${where}`, params);
    const logsRes  = await db.query(
      `SELECT * FROM ${s}._logs ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return { logs: logsRes.rows, total: countRes.rows[0].total, page, limit };
  });
};

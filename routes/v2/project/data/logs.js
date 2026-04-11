const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/logs", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          page:   { type: "integer", minimum: 1, default: 1 },
          limit:  { type: "integer", minimum: 1, maximum: 200, default: 100 },
          status: { type: "string" },
        },
      },
    },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s      = quoteIdent(schemaName);
    const page   = Math.max(1, req.query?.page  ?? 1);
    const limit  = Math.min(200, Math.max(1, req.query?.limit ?? 100));
    const offset = (page - 1) * limit;
    const status = req.query?.status;

    let where  = "";
    const params = [];

    if (status) {
      if (status === "2xx") where = "WHERE status_code >= 200 AND status_code < 300";
      else if (status === "4xx") where = "WHERE status_code >= 400 AND status_code < 500";
      else if (status === "5xx") where = "WHERE status_code >= 500";
      else { where = "WHERE status_code = $1"; params.push(parseInt(status, 10)); }
    }

    const [countRes, logsRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM ${s}._logs ${where}`, params),
      db.query(
        `SELECT * FROM ${s}._logs ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    return { logs: logsRes.rows, total: countRes.rows[0].total, page, limit };
  });
};

const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");
const { ensureV2Tables } = require("../../../../lib/v2/schema");

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/audit-log", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureV2Tables(schemaName).catch(() => {});

    const { action, collection, from, to, performed_by } = req.query;
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit ?? "50", 10)));
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10));

    const s      = quoteIdent(schemaName);
    const where  = [];
    const values = [];

    if (action) {
      values.push(action);
      where.push(`action = $${values.length}`);
    }
    if (collection) {
      values.push(`${collection}:%`);
      where.push(`entity LIKE $${values.length}`);
    }
    if (performed_by) {
      values.push(performed_by);
      where.push(`performed_by = $${values.length}`);
    }
    if (from) {
      values.push(from);
      where.push(`created_at >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      where.push(`created_at <= $${values.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM ${s}._audit_log ${whereClause}`, values),
      db.query(
        `SELECT id, action, entity, prev_value, new_value, performed_by, ip, created_at
         FROM ${s}._audit_log ${whereClause}
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
      ),
    ]);

    return {
      logs:   dataRes.rows,
      total:  countRes.rows[0].total,
      limit,
      offset,
    };
  });
};

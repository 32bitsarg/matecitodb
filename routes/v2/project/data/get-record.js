const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");
const { populateRecords }   = require("../../../../lib/v2/populate");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const { rows } = await db.query(
      `SELECT * FROM ${schema}._records
       WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW()) AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows[0]) return apiError(reply, "DATA_001");

    const perm = await checkPermissionV2(schemaName, rows[0].collection, "get", req, reply);
    if (!perm.allowed) return;

    // RLS: verify record matches filter
    if (perm.filterSql) {
      let rlsIdx = 1;
      const filterSql = perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`);
      const check = await db.query(
        `SELECT 1 FROM ${schema}._records WHERE id = $1 AND ${filterSql} LIMIT 1`,
        [id, ...perm.filterValues]
      );
      if (!check.rows[0]) return apiError(reply, "PERM_001");
    }

    let record = rows[0];

    // Populate relations if requested
    if (req.query.populate) {
      const { rows: fieldRows } = await db.query(
        `SELECT name, type, options FROM ${schema}._fields WHERE collection = $1`, [record.collection]
      );
      const [populated] = await populateRecords(schemaName, fieldRows, [record], req.query.populate);
      record = populated;
    }

    return { record };
  };

  projectRoute(fastify, "GET", "/records/:id", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};

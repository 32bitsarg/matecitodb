const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    // Necesitamos el collection del registro para chequear permisos; lo obtenemos junto con el registro
    const schema = quoteIdent(schemaName);

    const result = await db.query(
      `SELECT * FROM ${schema}._records
       WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW()) AND deleted_at IS NULL
       LIMIT 1`,
      [id]
    );

    if (!result.rows[0]) return reply.code(404).send({ error: "Record not found" });

    const perm = await checkPermission(schemaName, result.rows[0].collection, "get", req, reply);
    if (!perm.allowed) return;

    // RLS: verify record matches filter if present
    if (perm.filterSql) {
      let rlsIdx = 1; // id is $1
      const filterSql = perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`);
      const check = await db.query(
        `SELECT 1 FROM ${schema}._records WHERE id = $1 AND ${filterSql} LIMIT 1`,
        [id, ...perm.filterValues]
      );
      if (!check.rows[0]) return reply.code(403).send({ error: "Forbidden" });
    }

    return { record: result.rows[0] };
  };

  projectRoute(fastify, "GET", "/records/:id", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};

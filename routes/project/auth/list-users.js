const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  // GET /auth/users — lista usuarios del proyecto (admin/platform only)
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const schema = schemaName;

    const tbl = `${quoteIdent(schema)}."_auth_users"`;

    const pageNum  = Math.max(1, parseInt(req.query.page  || "1",  10));
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
    const offset   = (pageNum - 1) * limitNum;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM ${tbl}`),
      db.query(
        `SELECT id, email, username, name, oauth_provider,
                COALESCE(email_verified, oauth_provider IS NOT NULL) AS email_verified,
                email_verified_at, created_at, updated_at
         FROM ${tbl}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limitNum, offset]
      ),
    ]);

    const total = countRes.rows[0].count;

    return {
      users: dataRes.rows,
      total,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };
  };

  projectRoute(fastify, "GET", "/auth/users", { preHandler: requireProjectOrPlatformAuth }, handler);

  // DELETE /auth/users/:userId
  const deleteHandler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const schema = schemaName;

    const { userId } = req.params;
    const tbl = `${quoteIdent(schema)}."_auth_users"`;

    const res = await db.query(`DELETE FROM ${tbl} WHERE id = $1 RETURNING id`, [userId]);
    if (!res.rowCount) return reply.code(404).send({ error: "User not found" });

    return { ok: true };
  };

  projectRoute(fastify, "DELETE", "/auth/users/:userId", { preHandler: requireProjectOrPlatformAuth }, deleteHandler);
};

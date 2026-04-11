const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // GET /auth/users — list project users (admin/platform only)
  projectRoute(fastify, "GET", "/auth/users", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          page:  { type: "integer", minimum: 1, default: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
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

    const tbl     = `${quoteIdent(schemaName)}."_auth_users"`;
    const pageNum  = Math.max(1, req.query.page ?? 1);
    const limitNum = Math.min(100, Math.max(1, req.query.limit ?? 50));
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
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };
  });

  // DELETE /auth/users/:userId — delete a project user
  projectRoute(fastify, "DELETE", "/auth/users/:userId", {
    preHandler: requireProjectOrPlatformAuth,
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const { userId } = req.params;
    const tbl = `${quoteIdent(schemaName)}."_auth_users"`;

    const { rowCount } = await db.query(`DELETE FROM ${tbl} WHERE id = $1 RETURNING id`, [userId]);
    if (!rowCount) return apiError(reply, "GEN_003", "User not found");

    return { ok: true };
  });
};

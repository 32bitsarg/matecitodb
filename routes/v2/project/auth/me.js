const {
  db,
  requireProjectAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // GET /auth/me
  const getHandler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const authUser  = req.projectUser;

    if (authUser.pid !== projectId) return apiError(reply, "AUTH_001");

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, email, username, name, avatar_seed, avatar_url, email_verified, created_at, updated_at
       FROM ${schema}._auth_users WHERE id = $1 LIMIT 1`,
      [authUser.id]
    );

    if (!rows[0]) return apiError(reply, "GEN_003", "User not found");
    return { user: rows[0] };
  };

  // PATCH /auth/me
  const patchHandler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const authUser  = req.projectUser;

    if (authUser.pid !== projectId) return apiError(reply, "AUTH_001");

    const name     = req.body?.name     !== undefined ? String(req.body.name).trim()     : undefined;
    const username = req.body?.username !== undefined ? String(req.body.username).trim() : undefined;

    if (name === undefined && username === undefined) {
      return reply.code(400).send({ error: "Nothing to update", code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);
    const sets   = [];
    const values = [];

    if (name !== undefined)     { values.push(name);     sets.push(`name = $${values.length}`); }
    if (username !== undefined) { values.push(username); sets.push(`username = $${values.length}`); }

    values.push(authUser.id);
    const { rows } = await db.query(
      `UPDATE ${schema}._auth_users
       SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, email, username, name, avatar_seed, avatar_url, email_verified, created_at, updated_at`,
      values
    );

    return { user: rows[0] };
  };

  projectRoute(fastify, "GET",   "/auth/me", { preHandler: requireProjectAuth }, getHandler);
  projectRoute(fastify, "PATCH", "/auth/me", {
    preHandler: requireProjectAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          name:     { type: "string", minLength: 1, maxLength: 100 },
          username: { type: "string", minLength: 1, maxLength: 50 },
        },
      },
    },
  }, patchHandler);
};

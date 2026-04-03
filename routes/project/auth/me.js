const { db, requireProjectAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  // ─── GET /auth/me ──────────────────────────────────────────────────────────
  const getHandler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const authUser  = req.projectUser; // { id, pid, email, username, name }

    if (authUser.pid !== projectId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const schema  = quoteIdent(schemaName);
    const userRes = await db.query(
      `SELECT id, email, username, name, avatar_seed, avatar_url, created_at, updated_at
       FROM ${schema}._auth_users WHERE id = $1 LIMIT 1`,
      [authUser.id]
    );

    if (!userRes.rows[0]) return reply.code(404).send({ error: "User not found" });

    return { user: userRes.rows[0] };
  };

  // ─── PATCH /auth/me — actualizar perfil ───────────────────────────────────
  const patchHandler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const authUser  = req.projectUser;

    if (authUser.pid !== projectId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const name     = req.body?.name     !== undefined ? String(req.body.name).trim()     : undefined;
    const username = req.body?.username !== undefined ? String(req.body.username).trim() : undefined;

    if (name === undefined && username === undefined) {
      return reply.code(400).send({ error: "Nothing to update" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const schema = quoteIdent(schemaName);
    const sets   = [];
    const values = [];

    if (name !== undefined)     { values.push(name);     sets.push(`name = $${values.length}`); }
    if (username !== undefined) { values.push(username); sets.push(`username = $${values.length}`); }

    values.push(authUser.id);
    const result = await db.query(
      `UPDATE ${schema}._auth_users
       SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, email, username, name, avatar_seed, avatar_url, created_at, updated_at`,
      values
    );

    return { user: result.rows[0] };
  };

  projectRoute(fastify, "GET",   "/auth/me", { preHandler: requireProjectAuth }, getHandler);
  projectRoute(fastify, "PATCH", "/auth/me", { preHandler: requireProjectAuth }, patchHandler);
};

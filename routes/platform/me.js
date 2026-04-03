const { db, requirePlatformAuth } = require("../../lib/matecito");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  // GET /me
  fastify.get("/me", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId = req.user.id;

    const [userRes, workspacesRes, projectsRes] = await Promise.all([
      db.query(
        `SELECT id, username, name, email, avatar_seed, avatar_url, created_at
         FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      ),
      db.query(
        `SELECT w.id, w.name, w.slug, w.owner_id, wm.role, w.created_at
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = $1
         ORDER BY w.created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT
           p.id, p.name, p.subdomain, p.schema_name, p.workspace_id, p.created_at,
           w.name AS workspace_name,
           k_anon.key AS anon_key,
           k_srv.key  AS service_key
         FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         JOIN workspace_members wm ON wm.workspace_id = w.id
         LEFT JOIN api_keys k_anon ON k_anon.project_id = p.id AND k_anon.type = 'anon'    AND k_anon.revoked_at IS NULL
         LEFT JOIN api_keys k_srv  ON k_srv.project_id  = p.id AND k_srv.type  = 'service' AND k_srv.revoked_at  IS NULL
         WHERE wm.user_id = $1
         ORDER BY p.created_at DESC`,
        [userId]
      ),
    ]);

    if (!userRes.rows[0]) {
      return reply.code(404).send({ error: "User not found" });
    }

    const projects = projectsRes.rows.map((p) => ({
      ...p,
      url: `https://${p.subdomain}.${DOMAIN}`,
    }));

    return {
      user:       userRes.rows[0],
      workspaces: workspacesRes.rows,
      projects,
    };
  });

  // PATCH /me — actualizar perfil
  fastify.patch("/me", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId = req.user.id;

    const name     = req.body?.name     !== undefined ? String(req.body.name).trim()     : undefined;
    const username = req.body?.username !== undefined ? String(req.body.username).trim() : undefined;

    if (name === undefined && username === undefined) {
      return reply.code(400).send({ error: "Nothing to update" });
    }

    const sets   = [];
    const values = [];

    if (name !== undefined)     { values.push(name);     sets.push(`name = $${values.length}`); }
    if (username !== undefined) { values.push(username); sets.push(`username = $${values.length}`); }

    values.push(userId);
    const result = await db.query(
      `UPDATE users
       SET ${sets.join(", ")}
       WHERE id = $${values.length}
       RETURNING id, username, name, email, avatar_seed, avatar_url, created_at`,
      values
    );

    if (!result.rows[0]) return reply.code(404).send({ error: "User not found" });

    return { user: result.rows[0] };
  });
};

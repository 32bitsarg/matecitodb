const { db, requirePlatformAuth, isWorkspaceMember } = require("../../lib/matecito");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.get("/info-w/:workspaceId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { workspaceId } = req.params;

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const [workspaceRes, membersRes, projectsRes] = await Promise.all([
      db.query(
        `SELECT id, name, slug, subdomain, owner_id, created_at, updated_at
         FROM workspaces WHERE id = $1 LIMIT 1`,
        [workspaceId]
      ),
      db.query(
        `SELECT wm.user_id, wm.role, u.username, u.name, u.email, u.avatar_seed, u.avatar_url, wm.created_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1
         ORDER BY wm.created_at ASC`,
        [workspaceId]
      ),
      db.query(
        `SELECT id, name, subdomain, schema_name, created_at
         FROM projects WHERE workspace_id = $1
         ORDER BY created_at DESC`,
        [workspaceId]
      ),
    ]);

    if (!workspaceRes.rows[0]) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    const projects = projectsRes.rows.map((p) => ({
      ...p,
      url: `https://${p.subdomain}.${DOMAIN}`,
    }));

    return {
      workspace: workspaceRes.rows[0],
      role:      membership.role,
      members:   membersRes.rows,
      projects,
    };
  });
};

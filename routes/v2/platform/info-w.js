const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.get("/info-w/:workspaceId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId          = req.user.id;
    const { workspaceId } = req.params;

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) return apiError(reply, "PERM_001");

    const [workspaceRes, membersRes, projectsRes] = await Promise.all([
      db.query(
        `SELECT id, name, slug, owner_id, created_at FROM workspaces WHERE id = $1 LIMIT 1`,
        [workspaceId]
      ),
      db.query(
        `SELECT wm.user_id, wm.role, u.username, u.name, u.email, u.avatar_seed, u.avatar_url, wm.created_at
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1 ORDER BY wm.created_at ASC`,
        [workspaceId]
      ),
      db.query(
        `SELECT id, name, subdomain, schema_name, created_at FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId]
      ),
    ]);

    if (!workspaceRes.rows[0]) return apiError(reply, "PROJ_002");

    return {
      workspace: workspaceRes.rows[0],
      role:      membership.role,
      members:   membersRes.rows,
      projects:  projectsRes.rows.map(p => ({ ...p, url: `https://${p.subdomain}.${DOMAIN}` })),
    };
  });
};

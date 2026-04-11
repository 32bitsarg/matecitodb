const { db, requirePlatformAuth } = require("../../../lib/v2/auth");

module.exports = async function (fastify) {
  fastify.get("/list-w", { preHandler: requirePlatformAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT w.id, w.name, w.slug, w.owner_id, wm.role, w.created_at
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    return { workspaces: rows };
  });
};

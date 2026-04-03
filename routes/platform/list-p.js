const { db, requirePlatformAuth, isWorkspaceMember } = require("../../lib/matecito");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.get("/list-p", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const workspaceId = String(req.query?.workspaceId || "").trim();

    if (!workspaceId) {
      return reply.code(400).send({ error: "workspaceId is required" });
    }

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const result = await db.query(
      `SELECT id, workspace_id, name, subdomain, schema_name, created_at
       FROM projects WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );

    const projects = result.rows.map((p) => ({
      ...p,
      url: `https://${p.subdomain}.${DOMAIN}`,
    }));

    return { projects };
  });
};

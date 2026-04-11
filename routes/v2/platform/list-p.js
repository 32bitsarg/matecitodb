const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.get("/list-p", {
    preHandler: requirePlatformAuth,
    schema: {
      querystring: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
      },
    },
  }, async (req, reply) => {
    const userId      = req.user.id;
    const workspaceId = String(req.query.workspaceId || "").trim();

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) return apiError(reply, "PERM_001");

    const { rows } = await db.query(
      `SELECT id, workspace_id, name, subdomain, schema_name, created_at
       FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );

    return { projects: rows.map(p => ({ ...p, url: `https://${p.subdomain}.${DOMAIN}` })) };
  });
};

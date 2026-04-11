const { db, requirePlatformAuth, isProjectMember, isWorkspaceMember } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.patch("/rename-p/:projectId", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: { name: { type: "string", minLength: 2, maxLength: 64 } },
      },
    },
  }, async (req, reply) => {
    const userId        = req.user.id;
    const { projectId } = req.params;
    const name          = String(req.body.name || "").trim();

    const pm = await isProjectMember(userId, projectId);
    if (!pm) return apiError(reply, "PERM_001");

    const wm = await isWorkspaceMember(userId, pm.workspace_id);
    if (!wm || !["owner", "admin"].includes(wm.role)) return apiError(reply, "PERM_005");

    const { rows } = await db.query(
      `UPDATE projects SET name = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, workspace_id, name, subdomain, schema_name, created_at, updated_at`,
      [name, projectId]
    );

    if (!rows[0]) return apiError(reply, "PROJ_001");

    return { project: { ...rows[0], url: `https://${rows[0].subdomain}.${DOMAIN}` } };
  });
};

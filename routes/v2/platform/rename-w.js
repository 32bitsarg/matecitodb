const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.patch("/rename-w/:workspaceId", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: { name: { type: "string", minLength: 2, maxLength: 128 } },
      },
    },
  }, async (req, reply) => {
    const userId          = req.user.id;
    const { workspaceId } = req.params;
    const name            = String(req.body.name || "").trim();

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return apiError(reply, "PERM_001");
    }

    const { rows } = await db.query(
      `UPDATE workspaces SET name = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, slug, owner_id, created_at, updated_at`,
      [name, workspaceId]
    );

    if (!rows[0]) return apiError(reply, "PROJ_002");
    return { workspace: rows[0] };
  });
};

const { db, requirePlatformAuth, isWorkspaceMember, generateToken } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const VALID_ROLES = ["owner", "admin", "developer", "viewer"];

module.exports = async function (fastify) {
  fastify.post("/workspaces/:workspaceId/invites", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["email"],
        additionalProperties: false,
        properties: {
          email: { type: "string", format: "email", maxLength: 255 },
          role:  { type: "string", enum: VALID_ROLES },
        },
      },
    },
  }, async (req, reply) => {
    const userId          = req.user.id;
    const { workspaceId } = req.params;
    const email           = String(req.body.email || "").trim().toLowerCase();
    const role            = String(req.body.role  || "viewer").trim();

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return apiError(reply, "PERM_001");
    }

    const token = generateToken(20);

    const { rows } = await db.query(
      `INSERT INTO invites (workspace_id, email, role, token, status) VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, workspace_id, email, role, token, status, created_at`,
      [workspaceId, email, role, token]
    );

    return reply.code(201).send({ invite: rows[0] });
  });
};

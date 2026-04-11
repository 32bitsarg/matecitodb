const { db, requirePlatformAuth, isWorkspaceMember, generateToken } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const VALID_ROLES = ["owner", "admin", "developer", "viewer"];

module.exports = async function (fastify) {
  fastify.post("/workspaces/:workspaceId/members", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: "string" },
          email:  { type: "string", format: "email", maxLength: 255 },
          role:   { type: "string", enum: VALID_ROLES },
        },
      },
    },
  }, async (req, reply) => {
    const callerId        = req.user.id;
    const { workspaceId } = req.params;
    const targetUserId    = String(req.body?.userId || "").trim();
    const email           = String(req.body?.email  || "").trim().toLowerCase();
    const role            = String(req.body?.role   || "viewer").trim();

    const membership = await isWorkspaceMember(callerId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) return apiError(reply, "PERM_001");

    if (!targetUserId && !email) return apiError(reply, "GEN_001", "userId or email is required");

    let userId = targetUserId;

    if (!userId && email) {
      const { rows } = await db.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [email]);
      if (!rows[0]) {
        const token  = generateToken(20);
        const invite = await db.query(
          `INSERT INTO invites (workspace_id, email, role, token, status) VALUES ($1, $2, $3, $4, 'pending')
           RETURNING id, workspace_id, email, role, token, status, created_at`,
          [workspaceId, email, role, token]
        );
        return reply.code(201).send({ invited: true, invite: invite.rows[0] });
      }
      userId = rows[0].id;
    }

    const userExists = await db.query(`SELECT id, email, username, name FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (!userExists.rows[0]) return apiError(reply, "GEN_003", "User not found");

    const { rows } = await db.query(
      `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, user_id, workspace_id, role, created_at`,
      [userId, workspaceId, role]
    );

    return reply.code(201).send({ member: rows[0] });
  });
};

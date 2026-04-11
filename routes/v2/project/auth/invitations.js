// ─── Invitations (P2) ──────────────────────────────────────────────────────
//
// POST /auth/invitations           → crear invitación
// GET  /auth/invitations           → listar
// DELETE /auth/invitations/:id     → revocar
// POST /auth/invitations/:id/resend → reenviar email
// GET  /auth/invitations/accept?token=xxx → aceptar

const { db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const crypto             = require("crypto");

function hashToken(raw) { return crypto.createHash("sha256").update(raw).digest("hex"); }
function generateToken() { return crypto.randomBytes(32).toString("hex"); }

module.exports = async function (fastify) {
  // POST /auth/invitations
  fastify.post("/auth/invitations", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["email"], properties: { email: { type: "string" }, role: { type: "string" }, expires_in: { type: "string" }, redirect_url: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { email, role, expires_in = "7d", redirect_url } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const rawToken = generateToken();
    const hashed = hashToken(rawToken);
    const expiresMs = expires_in.match(/^(\d+)([dh])$/);
    const expiresAt = new Date(Date.now() + (expiresMs ? (parseInt(expiresMs[1]) * (expiresMs[2] === "d" ? 86400000 : 3600000)) : 7 * 86400000));
    const { rows } = await db.query(`INSERT INTO ${schema}._invitations (email, role, token, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [email, role || null, hashed, req.projectUser?.id || null, expiresAt]);
    const inviteUrl = `${req.protocol}://${req.hostname}/v2/p/${projectId}/auth/invitations/accept?token=${rawToken}`;
    return reply.code(201).send({ id: rows[0].id, email, invite_url: inviteUrl, expires_at: expiresAt });
  });

  // GET /auth/invitations
  fastify.get("/auth/invitations", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT id, email, role, invited_by, expires_at, accepted_at, created_at FROM ${quoteIdent(schemaName)}._invitations ORDER BY created_at DESC`);
    return { invitations: rows };
  });

  // DELETE /auth/invitations/:id
  fastify.delete("/auth/invitations/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._invitations WHERE id=$1`, [id]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { revoked: id };
  });

  // GET /auth/invitations/accept
  fastify.get("/auth/invitations/accept", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { token } = req.query;
    if (!token) return reply.code(400).send({ error: "token required" });
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const hashed = hashToken(token);
    const { rows } = await db.query(`SELECT * FROM ${schema}._invitations WHERE token=$1 AND expires_at > NOW() AND accepted_at IS NULL`, [hashed]);
    if (!rows[0]) return reply.code(400).send({ error: "Invalid or expired invitation" });
    const inv = rows[0];
    await db.query(`UPDATE ${schema}._invitations SET accepted_at = NOW() WHERE id=$1`, [inv.id]);
    // Assign role if user exists
    if (req.projectUser) {
      await db.query(`INSERT INTO ${schema}._user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.projectUser.id, inv.role]).catch(() => {});
    }
    return { ok: true, email: inv.email, role: inv.role, has_account: !!req.projectUser };
  });
};

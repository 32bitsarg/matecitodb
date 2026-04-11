const bcrypt = require("bcryptjs");
const {
  db,
  quoteIdent,
  projectRoute,
  createPasswordResetToken,
  verifyPasswordResetToken,
  logAuthEvent,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");
const { enqueueEmail } = require("../../../../lib/v2/queue");
const { ensureV2Tables } = require("../../../../lib/v2/schema");

module.exports = async function (fastify) {
  // POST /auth/request-reset  { email, reset_url_base? }
  projectRoute(fastify, "POST", "/auth/request-reset", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: {
      body: {
        type: "object",
        required: ["email"],
        additionalProperties: false,
        properties: {
          email:          { type: "string", format: "email", maxLength: 254 },
          reset_url_base: { type: "string", format: "uri", maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const email         = String(req.body.email || "").trim().toLowerCase();
    const resetUrlBase  = String(req.body.reset_url_base || "").trim();
    const s             = quoteIdent(schemaName);

    const { rows } = await db.query(
      `SELECT id, email FROM ${s}._auth_users WHERE email = $1 LIMIT 1`, [email]
    );
    // Always return 200 to avoid user enumeration
    if (!rows[0]) return { message: "If that email exists, a reset link has been sent." };

    await ensureV2Tables(schemaName).catch(() => {});

    // Token is stored HASHED in DB (v2 security improvement)
    const rawToken = await createPasswordResetToken(schemaName, rows[0].id);
    const resetLink = resetUrlBase ? `${resetUrlBase}?token=${rawToken}` : rawToken;

    const projectRow  = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    const projectName = projectRow.rows[0]?.name ?? "App";

    enqueueEmail(schemaName, projectName, {
      to:              rows[0].email,
      templateName:    "password_reset",
      vars:            { "user.email": rows[0].email, "reset_url": resetLink },
      fallbackSubject: `Restablecé tu contraseña — ${projectName}`,
      fallbackHtml:    `<p>Hacé click aquí para restablecer tu contraseña: <a href="${resetLink}">${resetLink}</a><br>Este enlace expira en 1 hora.</p>`,
    });

    if (process.env.NODE_ENV !== "production") {
      return { message: "If that email exists, a reset link has been sent.", _dev_token: rawToken };
    }
    return { message: "If that email exists, a reset link has been sent." };
  });

  // POST /auth/reset-password  { token, password }
  projectRoute(fastify, "POST", "/auth/reset-password", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    schema: {
      body: {
        type: "object",
        required: ["token", "password"],
        additionalProperties: false,
        properties: {
          token:    { type: "string", minLength: 1 },
          password: { type: "string", minLength: 8, maxLength: 128 },
        },
      },
    },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const { token, password } = req.body;
    const s = quoteIdent(schemaName);

    // verifyPasswordResetToken compares raw token against stored hash (timing-safe)
    const reset = await verifyPasswordResetToken(schemaName, token);
    if (!reset) return reply.code(400).send({ error: "Invalid or expired token", code: "AUTH_008" });

    const hash   = await bcrypt.hash(password, 12);
    const userId = reset.user_id;

    await db.query(
      `UPDATE ${s}._auth_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, userId]
    );
    await db.query(
      `UPDATE ${s}._password_resets SET used_at = NOW() WHERE id = $1`,
      [reset.id]
    );
    // Revoke all refresh tokens on password change
    await db.query(
      `UPDATE ${s}._refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    logAuthEvent(schemaName, { event: "password_reset", userId, ip: req.ip, status: 200 });

    return { message: "Password updated successfully." };
  });
};

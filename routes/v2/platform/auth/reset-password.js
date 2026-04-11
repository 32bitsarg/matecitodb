const bcrypt     = require("bcryptjs");
const crypto     = require("crypto");
const nodemailer = require("nodemailer");
const { db, hashToken } = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");
const { apiError } = require("../../../../lib/v2/errors");

async function ensureResetTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS platform_password_resets (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at    TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function sendResetEmail(to, resetLink) {
  const host = process.env.SMTP_HOST;
  if (!host) return;

  const transporter = nodemailer.createTransport({
    host,
    port:   Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || `"Matecito" <noreply@matecito.dev>`,
    to,
    subject: "Restablecé tu contraseña — Matecito",
    html: `
      <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en matecito.dev.</p>
      <p><a href="${resetLink}" style="font-weight:bold">Restablecer contraseña</a></p>
      <p>Este link expira en 1 hora. Si no hiciste esta solicitud, podés ignorar este email.</p>
    `,
  });
}

module.exports = async function (fastify) {
  // POST /auth/request-reset
  fastify.post("/auth/request-reset", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { body: bodySchema.requestReset },
  }, async (req, reply) => {
    const email        = String(req.body.email          || "").trim().toLowerCase();
    const resetUrlBase = String(req.body.reset_url_base || "").trim();

    await ensureResetTable();

    const userRes = await db.query(
      `SELECT id, email FROM users WHERE email = $1 LIMIT 1`, [email]
    );
    // Siempre 200 para evitar enumeración de usuarios
    if (!userRes.rows[0]) return { message: "If that email exists, a reset link has been sent." };

    const userId  = userRes.rows[0].id;
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashed  = hashToken(rawToken); // v2: guardamos hash en DB
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await db.query(
      `UPDATE platform_password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    await db.query(
      `INSERT INTO platform_password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, hashed, expires]
    );

    const resetLink = resetUrlBase ? `${resetUrlBase}?token=${rawToken}` : rawToken;
    sendResetEmail(email, resetLink).catch(err =>
      req.log.warn({ step: "platform_reset_email", error: err.message })
    );

    if (process.env.NODE_ENV !== "production") {
      return { message: "If that email exists, a reset link has been sent.", _dev_token: rawToken };
    }
    return { message: "If that email exists, a reset link has been sent." };
  });

  // POST /auth/reset-password
  fastify.post("/auth/reset-password", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    schema: { body: bodySchema.resetPassword },
  }, async (req, reply) => {
    const { token, password } = req.body;

    await ensureResetTable();

    const hashed = hashToken(token);
    const reset  = await db.query(
      `SELECT * FROM platform_password_resets
       WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL LIMIT 1`,
      [hashed]
    );
    if (!reset.rows[0]) return apiError(reply, "AUTH_010");

    const hash   = await bcrypt.hash(password, 12);
    const userId = reset.rows[0].user_id;

    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId]);
    await db.query(`UPDATE platform_password_resets SET used_at = NOW() WHERE id = $1`, [reset.rows[0].id]);
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    ).catch(() => {});

    return { message: "Password updated successfully." };
  });
};

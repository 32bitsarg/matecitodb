const crypto  = require("crypto");
const bcrypt  = require("bcryptjs");
const nodemailer = require("nodemailer");
const { db }  = require("../../../lib/matecito");

// ─── helpers ──────────────────────────────────────────────────────────────────

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
  if (!host) return; // no SMTP configured — dev mode returns _dev_token instead

  const transporter = nodemailer.createTransport({
    host,
    port:   Number(process.env.SMTP_PORT  || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
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

// ─── routes ───────────────────────────────────────────────────────────────────

module.exports = async function (fastify) {

  // POST /auth/request-reset  { email, reset_url_base? }
  fastify.post("/auth/request-reset", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const email         = String(req.body?.email          || "").trim().toLowerCase();
    const resetUrlBase  = String(req.body?.reset_url_base || "").trim();
    if (!email) return reply.code(400).send({ error: "email is required" });

    await ensureResetTable();

    const userRes = await db.query(
      `SELECT id, email FROM users WHERE email = $1 LIMIT 1`, [email]
    );
    // Always 200 to avoid user enumeration
    if (!userRes.rows[0]) return { message: "If that email exists, a reset link has been sent." };

    const userId = userRes.rows[0].id;
    const token  = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate previous pending tokens
    await db.query(
      `UPDATE platform_password_resets SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`, [userId]
    );
    await db.query(
      `INSERT INTO platform_password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, token, expires]
    );

    const resetLink = resetUrlBase ? `${resetUrlBase}?token=${token}` : token;
    await sendResetEmail(email, resetLink).catch(err =>
      fastify.log.warn("Platform reset email failed:", err.message)
    );

    if (process.env.NODE_ENV !== "production") {
      return { message: "If that email exists, a reset link has been sent.", _dev_token: token };
    }
    return { message: "If that email exists, a reset link has been sent." };
  });

  // POST /auth/reset-password  { token, password }
  fastify.post("/auth/reset-password", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const { token, password } = req.body ?? {};
    if (!token || !password) return reply.code(400).send({ error: "token and password are required" });
    if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });

    await ensureResetTable();

    const reset = await db.query(
      `SELECT * FROM platform_password_resets
       WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL LIMIT 1`,
      [token]
    );
    if (!reset.rows[0]) return reply.code(400).send({ error: "Invalid or expired token" });

    const hash   = await bcrypt.hash(password, 12);
    const userId = reset.rows[0].user_id;

    await db.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId]
    );
    await db.query(
      `UPDATE platform_password_resets SET used_at = NOW() WHERE id = $1`, [reset.rows[0].id]
    );
    // Revoke all platform refresh tokens so existing sessions are invalidated
    await db.query(
      `UPDATE platform_refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`, [userId]
    ).catch(() => {}); // table may not exist on older setups

    return { message: "Password updated successfully." };
  });
};

const nodemailer = require("nodemailer");
const { db, quoteIdent, projectRoute, requireProjectOrPlatformAuth } = require("../../lib/matecito");

// ─── Helper: get SMTP config for a project schema ─────────────────────────────
async function getSmtpConfig(schemaName) {
  const s = quoteIdent(schemaName);
  const { rows } = await db.query(`SELECT * FROM ${s}._smtp_config LIMIT 1`);
  return rows[0] ?? null;
}

// ─── Helper: build transporter from config ────────────────────────────────────
function buildTransporter(cfg) {
  return nodemailer.createTransport({
    host:   cfg.host,
    port:   cfg.port,
    secure: cfg.secure,
    auth:   { user: cfg.smtp_user, pass: cfg.smtp_password },
  });
}

module.exports = async function (fastify) {

  // GET /smtp — leer config (sin exponer la contraseña completa)
  projectRoute(fastify, "GET", "/smtp", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = req.resolvedProject?.schema_name ?? (await resolveSchema(req));
    if (!schema) return reply.code(404).send({ error: "Project not found" });

    const cfg = await getSmtpConfig(schema);
    if (!cfg) return { configured: false, smtp: null };

    return {
      configured: true,
      smtp: {
        host:          cfg.host,
        port:          cfg.port,
        secure:        cfg.secure,
        smtp_user:     cfg.smtp_user,
        smtp_password: cfg.smtp_password ? "***" : "",
        from_name:     cfg.from_name,
        from_email:    cfg.from_email,
      },
    };
  });

  // PUT /smtp — guardar o actualizar config
  projectRoute(fastify, "PUT", "/smtp", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = req.resolvedProject?.schema_name ?? (await resolveSchema(req));
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);

    const { host, port, secure, smtp_user, smtp_password, from_name, from_email } = req.body ?? {};
    if (!host || !port || !smtp_user || !from_email)
      return reply.code(400).send({ error: "host, port, smtp_user y from_email son obligatorios" });

    // Si la contraseña viene como "***", no la actualizamos
    let passToSave = smtp_password;
    if (smtp_password === "***" || smtp_password === "") {
      const existing = await getSmtpConfig(schema);
      passToSave = existing?.smtp_password ?? "";
    }

    await db.query(`
      INSERT INTO ${s}._smtp_config (host, port, secure, smtp_user, smtp_password, from_name, from_email)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        host          = EXCLUDED.host,
        port          = EXCLUDED.port,
        secure        = EXCLUDED.secure,
        smtp_user     = EXCLUDED.smtp_user,
        smtp_password = CASE WHEN $5 != '' THEN EXCLUDED.smtp_password ELSE ${s}._smtp_config.smtp_password END,
        from_name     = EXCLUDED.from_name,
        from_email    = EXCLUDED.from_email,
        updated_at    = NOW()
    `, [host, parseInt(port, 10), !!secure, smtp_user, passToSave, from_name ?? "", from_email]);

    return { ok: true };
  });

  // DELETE /smtp — eliminar config
  projectRoute(fastify, "DELETE", "/smtp", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = req.resolvedProject?.schema_name ?? (await resolveSchema(req));
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);
    await db.query(`DELETE FROM ${s}._smtp_config`);
    return { ok: true };
  });

  // POST /smtp/test — enviar email de prueba
  projectRoute(fastify, "POST", "/smtp/test", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const schema = req.resolvedProject?.schema_name ?? (await resolveSchema(req));
    if (!schema) return reply.code(404).send({ error: "Project not found" });

    const cfg = await getSmtpConfig(schema);
    if (!cfg) return reply.code(400).send({ error: "SMTP no configurado" });

    const { to } = req.body ?? {};
    if (!to) return reply.code(400).send({ error: "to es obligatorio" });

    try {
      const transporter = buildTransporter(cfg);
      await transporter.sendMail({
        from:    `"${cfg.from_name || "Matebase"}" <${cfg.from_email}>`,
        to,
        subject: "Test de conexión SMTP — Matebase",
        html:    `<p>Si recibiste este email, tu configuración SMTP está funcionando correctamente.</p>`,
        text:    "Si recibiste este email, tu configuración SMTP está funcionando correctamente.",
      });
      return { ok: true, message: `Email de prueba enviado a ${to}` };
    } catch (err) {
      return reply.code(400).send({ error: "Error al enviar: " + err.message });
    }
  });
};

async function resolveSchema(req) {
  const projectId = req.params?.projectId;
  if (!projectId) return null;
  const { rows } = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
  return rows[0]?.schema_name ?? null;
}

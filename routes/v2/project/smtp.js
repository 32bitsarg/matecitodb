const nodemailer = require("nodemailer");
const {
  db,
  quoteIdent,
  projectRoute,
  requireProjectOrPlatformAuth,
} = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

async function resolveSchema(req) {
  if (req.resolvedProject?.schema_name) return req.resolvedProject.schema_name;
  const projectId = req.params?.projectId;
  if (!projectId) return null;
  const { rows } = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
  return rows[0]?.schema_name ?? null;
}

async function getSmtpConfig(schemaName) {
  const s = quoteIdent(schemaName);
  const { rows } = await db.query(`SELECT * FROM ${s}._smtp_config LIMIT 1`);
  return rows[0] ?? null;
}

function buildTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_password },
  });
}

module.exports = async function (fastify) {
  // GET /smtp
  projectRoute(fastify, "GET", "/smtp", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");

    const cfg = await getSmtpConfig(schema);
    if (!cfg) return { configured: false, smtp: null };

    return {
      configured: true,
      smtp: {
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        smtp_user: cfg.smtp_user,
        smtp_password: cfg.smtp_password ? "***" : "",
        from_name: cfg.from_name,
        from_email: cfg.from_email,
      },
    };
  });

  // PUT /smtp
  projectRoute(fastify, "PUT", "/smtp", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["host", "port", "smtp_user", "from_email"],
        additionalProperties: false,
        properties: {
          host:          { type: "string" },
          port:          { type: "integer", minimum: 1, maximum: 65535 },
          secure:        { type: "boolean", default: false },
          smtp_user:     { type: "string" },
          smtp_password: { type: "string" },
          from_name:     { type: "string" },
          from_email:    { type: "string", format: "email" },
        },
      },
    },
  }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schema);
    const { host, port, secure, smtp_user, smtp_password, from_name, from_email } = req.body;

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
    `, [host, port, !!secure, smtp_user, passToSave, from_name ?? "", from_email]);

    return { ok: true };
  });

  // DELETE /smtp
  projectRoute(fastify, "DELETE", "/smtp", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    await db.query(`DELETE FROM ${quoteIdent(schema)}._smtp_config`);
    return { ok: true };
  });

  // POST /smtp/test
  projectRoute(fastify, "POST", "/smtp/test", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["to"],
        additionalProperties: false,
        properties: { to: { type: "string", format: "email" } },
      },
    },
    config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");

    const cfg = await getSmtpConfig(schema);
    if (!cfg) return reply.code(400).send({ error: "SMTP not configured", code: "GEN_003" });

    const { to } = req.body;
    try {
      const transporter = buildTransporter(cfg);
      await transporter.sendMail({
        from:    `"${cfg.from_name || "Matebase"}" <${cfg.from_email}>`,
        to,
        subject: "SMTP Test — Matebase",
        html:    `<p>SMTP configuration is working correctly.</p>`,
        text:    "SMTP configuration is working correctly.",
      });
      return { ok: true, message: `Test email sent to ${to}` };
    } catch (err) {
      return reply.code(400).send({ error: "Send failed: " + err.message, code: "GEN_004" });
    }
  });
};

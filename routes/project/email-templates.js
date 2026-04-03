const { db, quoteIdent, projectRoute, requireProjectOrPlatformAuth } = require("../../lib/matecito");

// ─── Templates predefinidos que se insertan al activar SMTP ───────────────────
const DEFAULT_TEMPLATES = [
  {
    name:      "reset-password",
    subject:   "Restablecer tu contraseña",
    html_body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="background:linear-gradient(135deg,#7c3aed,#6d28d9);padding:32px 40px;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{{project.name}}</h1>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="margin:0 0 16px;color:#0f172a;font-size:20px;">Restablecer contraseña</h2>
          <p style="margin:0 0 24px;color:#475569;line-height:1.6;">Hola {{user.email}},<br><br>Recibimos una solicitud para restablecer la contraseña de tu cuenta. Hacé clic en el botón de abajo para continuar.</p>
          <a href="{{reset_link}}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">Restablecer contraseña</a>
          <p style="margin:24px 0 0;color:#94a3b8;font-size:13px;">Este enlace expira en 1 hora. Si no solicitaste esto, ignorá este email.</p>
          <hr style="margin:32px 0;border:none;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#cbd5e1;font-size:12px;">Si el botón no funciona, copiá este enlace: <a href="{{reset_link}}" style="color:#7c3aed;">{{reset_link}}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text_body: "Hola {{user.email}},\n\nRecibimos una solicitud para restablecer tu contraseña.\n\nUsá este enlace (válido por 1 hora):\n{{reset_link}}\n\nSi no solicitaste esto, ignorá este email.",
    variables: ["user.email", "reset_link", "project.name"],
    is_system:  true,
  },
  {
    name:      "welcome",
    subject:   "Bienvenido/a a {{project.name}}",
    html_body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="background:linear-gradient(135deg,#7c3aed,#6d28d9);padding:32px 40px;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{{project.name}}</h1>
        </td></tr>
        <tr><td style="padding:40px;">
          <h2 style="margin:0 0 16px;color:#0f172a;font-size:20px;">¡Bienvenido/a!</h2>
          <p style="margin:0 0 24px;color:#475569;line-height:1.6;">Hola {{user.email}},<br><br>Tu cuenta fue creada exitosamente. Ya podés iniciar sesión y comenzar a usar la plataforma.</p>
          <a href="{{login_url}}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">Iniciar sesión</a>
          <hr style="margin:32px 0;border:none;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#cbd5e1;font-size:12px;">Si no creaste una cuenta, ignorá este email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text_body: "Hola {{user.email}},\n\nTu cuenta en {{project.name}} fue creada exitosamente.\n\nIniciá sesión en: {{login_url}}",
    variables: ["user.email", "login_url", "project.name"],
    is_system:  true,
  },
];

module.exports = async function (fastify) {

  // GET /email-templates — listar todos
  projectRoute(fastify, "GET", "/email-templates", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);

    const { rows } = await db.query(
      `SELECT id, name, subject, html_body, text_body, variables, is_system, updated_at
       FROM ${s}._email_templates ORDER BY is_system DESC, name ASC`
    );
    return { templates: rows };
  });

  // GET /email-templates/:id — obtener uno
  projectRoute(fastify, "GET", "/email-templates/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);

    const { rows } = await db.query(
      `SELECT * FROM ${s}._email_templates WHERE id = $1 LIMIT 1`, [req.params.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Template not found" });
    return { template: rows[0] };
  });

  // POST /email-templates — crear template custom
  projectRoute(fastify, "POST", "/email-templates", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);

    const { name, subject, html_body, text_body, variables } = req.body ?? {};
    if (!name || !subject || !html_body)
      return reply.code(400).send({ error: "name, subject y html_body son obligatorios" });

    const { rows } = await db.query(
      `INSERT INTO ${s}._email_templates (name, subject, html_body, text_body, variables, is_system)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING *`,
      [name, subject, html_body, text_body ?? "", variables ?? extractVariables(html_body)]
    );
    return reply.code(201).send({ template: rows[0] });
  });

  // PATCH /email-templates/:id — editar
  projectRoute(fastify, "PATCH", "/email-templates/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);

    const { subject, html_body, text_body, variables } = req.body ?? {};

    const fields   = [];
    const vals     = [];
    let   i        = 1;

    if (subject   != null) { fields.push(`subject = $${i++}`);   vals.push(subject); }
    if (html_body != null) { fields.push(`html_body = $${i++}`); vals.push(html_body); }
    if (text_body != null) { fields.push(`text_body = $${i++}`); vals.push(text_body); }
    if (variables != null) { fields.push(`variables = $${i++}`); vals.push(variables); }
    else if (html_body)    { fields.push(`variables = $${i++}`); vals.push(extractVariables(html_body)); }

    if (!fields.length) return reply.code(400).send({ error: "Nada para actualizar" });

    fields.push(`updated_at = NOW()`);
    vals.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE ${s}._email_templates SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows[0]) return reply.code(404).send({ error: "Template not found" });
    return { template: rows[0] };
  });

  // DELETE /email-templates/:id — solo custom (no system)
  projectRoute(fastify, "DELETE", "/email-templates/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schema);

    const { rows } = await db.query(
      `DELETE FROM ${s}._email_templates WHERE id = $1 AND is_system = false RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return reply.code(400).send({ error: "No se puede eliminar — no existe o es un template del sistema" });
    return { ok: true };
  });

  // POST /email-templates/seed — insertar templates por defecto
  projectRoute(fastify, "POST", "/email-templates/seed", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return reply.code(404).send({ error: "Project not found" });
    await seedDefaultTemplates(schema);
    return { ok: true, seeded: DEFAULT_TEMPLATES.length };
  });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractVariables(html) {
  const matches = [...html.matchAll(/\{\{([^}]+)\}\}/g)];
  return [...new Set(matches.map(m => m[1].trim()))];
}

async function resolveSchema(req) {
  const schema = req.resolvedProject?.schema_name;
  if (schema) return schema;
  const projectId = req.params?.projectId;
  if (!projectId) return null;
  const { rows } = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
  return rows[0]?.schema_name ?? null;
}

async function seedDefaultTemplates(schemaName) {
  const s = quoteIdent(schemaName);
  for (const t of DEFAULT_TEMPLATES) {
    await db.query(`
      INSERT INTO ${s}._email_templates (name, subject, html_body, text_body, variables, is_system)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (name) DO NOTHING
    `, [t.name, t.subject, t.html_body, t.text_body, t.variables, t.is_system]);
  }
}

module.exports.seedDefaultTemplates = seedDefaultTemplates;

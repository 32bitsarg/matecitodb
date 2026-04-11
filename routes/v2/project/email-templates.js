const {
  db,
  quoteIdent,
  projectRoute,
  requireProjectOrPlatformAuth,
} = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

function extractVariables(html) {
  const matches = [...html.matchAll(/\{\{([^}]+)\}\}/g)];
  return [...new Set(matches.map(m => m[1].trim()))];
}

async function resolveSchema(req) {
  if (req.resolvedProject?.schema_name) return req.resolvedProject.schema_name;
  const projectId = req.params?.projectId;
  if (!projectId) return null;
  const { rows } = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
  return rows[0]?.schema_name ?? null;
}

module.exports = async function (fastify) {
  // GET /email-templates
  projectRoute(fastify, "GET", "/email-templates", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schema);
    const { rows } = await db.query(
      `SELECT id, name, subject, html_body, text_body, variables, is_system, updated_at
       FROM ${s}._email_templates ORDER BY is_system DESC, name ASC`
    );
    return { templates: rows };
  });

  // GET /email-templates/:id
  projectRoute(fastify, "GET", "/email-templates/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schema);
    const { rows } = await db.query(
      `SELECT * FROM ${s}._email_templates WHERE id = $1 LIMIT 1`, [req.params.id]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Template not found");
    return { template: rows[0] };
  });

  // POST /email-templates
  projectRoute(fastify, "POST", "/email-templates", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name", "subject", "html_body"],
        additionalProperties: false,
        properties: {
          name:      { type: "string", minLength: 1, maxLength: 100 },
          subject:   { type: "string", minLength: 1 },
          html_body: { type: "string", minLength: 1 },
          text_body: { type: "string" },
          variables: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schema);
    const { name, subject, html_body, text_body, variables } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ${s}._email_templates (name, subject, html_body, text_body, variables, is_system)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING *`,
      [name, subject, html_body, text_body ?? "", variables ?? extractVariables(html_body)]
    );
    return reply.code(201).send({ template: rows[0] });
  });

  // PATCH /email-templates/:id
  projectRoute(fastify, "PATCH", "/email-templates/:id", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject:   { type: "string" },
          html_body: { type: "string" },
          text_body: { type: "string" },
          variables: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schema);

    const { subject, html_body, text_body, variables } = req.body ?? {};
    const fields = [];
    const vals   = [];
    let   i      = 1;

    if (subject   != null) { fields.push(`subject = $${i++}`);   vals.push(subject); }
    if (html_body != null) { fields.push(`html_body = $${i++}`); vals.push(html_body); }
    if (text_body != null) { fields.push(`text_body = $${i++}`); vals.push(text_body); }
    if (variables != null) { fields.push(`variables = $${i++}`); vals.push(variables); }
    else if (html_body)    { fields.push(`variables = $${i++}`); vals.push(extractVariables(html_body)); }

    if (!fields.length) return reply.code(400).send({ error: "Nothing to update", code: "GEN_002" });

    fields.push("updated_at = NOW()");
    vals.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE ${s}._email_templates SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, vals
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Template not found");
    return { template: rows[0] };
  });

  // DELETE /email-templates/:id
  projectRoute(fastify, "DELETE", "/email-templates/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schema);
    const { rows } = await db.query(
      `DELETE FROM ${s}._email_templates WHERE id = $1 AND is_system = false RETURNING id`, [req.params.id]
    );
    if (!rows[0]) return reply.code(400).send({ error: "Cannot delete — not found or is a system template", code: "GEN_002" });
    return { ok: true };
  });

  // POST /email-templates/seed
  projectRoute(fastify, "POST", "/email-templates/seed", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schema = await resolveSchema(req);
    if (!schema) return apiError(reply, "GEN_003", "Project not found");
    // Delegate to v1's seed function which has the default templates
    const { seedDefaultTemplates } = require("../../project/email-templates");
    await seedDefaultTemplates(schema);
    return { ok: true };
  });
};

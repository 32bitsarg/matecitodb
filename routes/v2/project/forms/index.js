// ─── Forms CRUD (L2) ───────────────────────────────────────────────────────
//
// GET    /forms                    → listar
// POST   /forms                    → crear
// GET    /forms/:name              → detalle
// PATCH  /forms/:name              → actualizar
// DELETE /forms/:name              → eliminar
// GET    /forms/:name/submissions  → ver submissions (auth required)

const {
  db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // GET /forms
  fastify.get("/forms", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._forms ORDER BY created_at DESC`);
    return { forms: rows };
  });

  // POST /forms
  fastify.post("/forms", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["name","collection","fields"], properties: { name: { type: "string" }, collection: { type: "string" }, fields: { type: "array" }, require_app_check: { type: "boolean" }, send_confirmation: { type: "boolean" }, confirmation_email_field: { type: "string" }, confirmation_template: { type: "string" }, notify_email: { type: "string" }, redirect_url: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name, collection, fields, require_app_check, send_confirmation, confirmation_email_field, confirmation_template, notify_email, redirect_url } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(`INSERT INTO ${schema}._forms (name,collection,fields,require_app_check,send_confirmation,confirmation_email_field,confirmation_template,notify_email,redirect_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [name, collection, JSON.stringify(fields), require_app_check||false, send_confirmation||false, confirmation_email_field||null, confirmation_template||null, notify_email||null, redirect_url||null]);
    return reply.code(201).send({ form: rows[0] });
  });

  // GET /forms/:name
  fastify.get("/forms/:name", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._forms WHERE name=$1`, [name]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { form: rows[0] };
  });

  // PATCH /forms/:name
  fastify.patch("/forms/:name", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", properties: { fields: { type: "array" }, require_app_check: { type: "boolean" }, send_confirmation: { type: "boolean" }, confirmation_email_field: { type: "string" }, confirmation_template: { type: "string" }, notify_email: { type: "string" }, redirect_url: { type: "string" }, is_active: { type: "boolean" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const u = []; const v = [];
    const set = (key, val) => { if (val !== undefined) { v.push(val); u.push(`${key}=$${v.length}`); } };
    const b = req.body;
    set("fields", b.fields ? JSON.stringify(b.fields) : undefined);
    set("require_app_check", b.require_app_check);
    set("send_confirmation", b.send_confirmation);
    set("confirmation_email_field", b.confirmation_email_field);
    set("confirmation_template", b.confirmation_template);
    set("notify_email", b.notify_email);
    set("redirect_url", b.redirect_url);
    set("is_active", b.is_active);
    if (!u.length) return reply.code(400).send({ error: "No fields to update" });
    v.push(name);
    const { rows } = await db.query(`UPDATE ${schema}._forms SET ${u.join(",")} WHERE name=$${v.length} RETURNING *`, v);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { form: rows[0] };
  });

  // DELETE /forms/:name
  fastify.delete("/forms/:name", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._forms WHERE name=$1`, [name]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { deleted: name };
  });

  // GET /forms/:name/submissions
  fastify.get("/forms/:name/submissions", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const { limit = "50" } = req.query;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows: formRows } = await db.query(`SELECT collection FROM ${schema}._forms WHERE name=$1`, [name]);
    if (!formRows[0]) return apiError(reply, "GEN_003");
    const { rows } = await db.query(`SELECT * FROM ${schema}._records WHERE collection=$1 ORDER BY created_at DESC LIMIT $2`, [formRows[0].collection, parseInt(limit, 10)]);
    return { form: name, submissions: rows };
  });
};

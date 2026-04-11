// ─── Email Logs (M2) ───────────────────────────────────────────────────────
//
// GET  /email-logs                      → historial
// GET  /email-logs/stats                → estadísticas
// POST /email-templates/:name/preview   → preview sin enviar
// POST /email-templates/:name/send-test → enviar test

const { db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../lib/v2/schema");
const { apiError }       = require("../../../lib/v2/errors");

function renderTemplate(str, vars) { return str.replace(/\{\{([^}]+)\}\}/g, (_, k) => vars[k.trim()] ?? ""); }

module.exports = async function (fastify) {
  // GET /email-logs
  fastify.get("/email-logs", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { to_email, template, status, from, to, limit = "50" } = req.query;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const w = []; const v = [];
    if (to_email) { v.push(to_email); w.push(`to_email=$${v.length}`); }
    if (template) { v.push(template); w.push(`template=$${v.length}`); }
    if (status) { v.push(status); w.push(`status=$${v.length}`); }
    if (from) { v.push(from); w.push(`created_at>=$${v.length}`); }
    if (to) { v.push(to); w.push(`created_at<=$${v.length}`); }
    v.push(parseInt(limit, 10) || 50);
    const { rows } = await db.query(`SELECT * FROM ${schema}._email_logs ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${v.length}`, v);
    return { logs: rows, total: rows.length };
  });

  // GET /email-logs/stats
  fastify.get("/email-logs/stats", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { from, to } = req.query;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const w = []; const v = [];
    if (from) { v.push(from); w.push(`created_at>=$${v.length}`); }
    if (to) { v.push(to); w.push(`created_at<=$${v.length}`); }
    const where = w.length ? `WHERE ${w.join(" AND ")}` : "";
    const { rows } = await db.query(`SELECT COUNT(*) FILTER (WHERE status='sent') AS sent, COUNT(*) FILTER (WHERE status='failed') AS failed, COUNT(*) AS total FROM ${schema}._email_logs ${where}`, v);
    const stats = rows[0];
    const total = parseInt(stats.total, 10);
    return { sent: parseInt(stats.sent, 10), failed: parseInt(stats.failed, 10), total };
  });

  // POST /email-templates/:name/preview
  fastify.post("/email-templates/:name/preview", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", properties: { variables: { type: "object" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const { variables = {} } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${schema}._email_templates WHERE name=$1`, [name]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    const tpl = rows[0];
    return { subject: renderTemplate(tpl.subject, variables), html: renderTemplate(tpl.html_body || "", variables), text: renderTemplate(tpl.text_body || "", variables) };
  });

  // GET /email-templates/:name/variables
  fastify.get("/email-templates/:name/variables", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(`SELECT subject, html_body, text_body, variables FROM ${schema}._email_templates WHERE name=$1`, [name]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    const tpl = rows[0];
    const bodyText = `${tpl.subject || ""} ${tpl.html_body || ""} ${tpl.text_body || ""}`;
    const vars = new Set();
    const regex = /\{\{([^}]+)\}\}/g;
    let m;
    while ((m = regex.exec(bodyText)) !== null) vars.add(m[1].trim());
    const typedVars = {};
    if (tpl.variables && typeof tpl.variables === "object") {
      for (const [k, v] of Object.entries(tpl.variables)) typedVars[k] = v;
    }
    for (const v of vars) { if (!typedVars[v]) typedVars[v] = { type: "string", required: false }; }
    return { variables: typedVars };
  });
};

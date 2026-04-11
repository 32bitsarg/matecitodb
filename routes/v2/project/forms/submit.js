// ─── Form Public Submit (L2) ───────────────────────────────────────────────
//
// POST /f/:formId  → submission pública (sin auth)
// Soporta JSON y application/x-www-form-urlencoded (HTML forms).

const { db, quoteIdent, projectRoute, flexAuth } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const { emitProjectEvent } = require("../../../../lib/v2/realtime");

const RATE_LIMIT_MAP = new Map(); // "formId:ip" -> { count, resetAt }

function checkRateLimit(formId, ip) {
  const key = `${formId}:${ip}`;
  const entry = RATE_LIMIT_MAP.get(key);
  if (entry) {
    if (Date.now() > entry.resetAt) { RATE_LIMIT_MAP.delete(key); return true; }
    if (entry.count >= 5) return false;
    entry.count++;
    return true;
  }
  RATE_LIMIT_MAP.set(key, { count: 1, resetAt: Date.now() + 60000 });
  return true;
}

module.exports = async function (fastify) {
  fastify.post("/f/:formId", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { formId } = req.params;

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);

    // Find form by name or id
    const isUUID = /^[0-9a-f-]{36}$/i.test(formId);
    const { rows: formRows } = await db.query(
      `SELECT * FROM ${schema}._forms WHERE ${isUUID ? "id" : "name"} = $1 AND is_active = true`,
      [formId]
    );
    if (!formRows[0]) return apiError(reply, "GEN_003", "Form not found or inactive");

    const form = formRows[0];

    // Rate limit
    if (!checkRateLimit(form.id, req.ip)) {
      return reply.code(429).send({ error: "Too many submissions. Try again later.", code: "GEN_005" });
    }

    // Parse body (JSON or form-urlencoded)
    let submissionData;
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      submissionData = req.body; // Fastify parses it if configured
    } else {
      submissionData = req.body || {};
    }

    // Validate fields against form schema
    const fields = form.fields || [];
    const errors = [];
    const cleanData = {};

    for (const field of fields) {
      const val = submissionData[field.name];
      if (field.required && (val === undefined || val === null || val === "")) {
        errors.push({ field: field.name, message: "Required" });
        continue;
      }
      if (val === undefined) continue;

      let cleaned = val;
      if (field.maxLength && typeof val === "string" && val.length > field.maxLength) {
        errors.push({ field: field.name, message: `Max length: ${field.maxLength}` });
        continue;
      }
      if (field.type === "email" && typeof val === "string" && !val.includes("@")) {
        errors.push({ field: field.name, message: "Invalid email" });
        continue;
      }
      if (field.type === "select" && field.options && !field.options.includes(val)) {
        errors.push({ field: field.name, message: "Invalid option" });
        continue;
      }
      cleanData[field.name] = cleaned;
    }

    if (errors.length > 0) {
      return reply.code(400).send({ error: "Validation failed", errors });
    }

    cleanData._form_id = form.id;
    cleanData._form_name = form.name;
    cleanData._submitted_at = new Date().toISOString();
    cleanData._ip = req.ip;

    // Save to collection
    const { rows } = await db.query(
      `INSERT INTO ${schema}._records (collection, data) VALUES ($1, $2) RETURNING id`,
      [form.collection, JSON.stringify(cleanData)]
    );

    // Increment submit count
    await db.query(`UPDATE ${schema}._forms SET submit_count = submit_count + 1 WHERE id = $1`, [form.id]).catch(() => {});

    // If redirect_url and Accept: text/html → 302 redirect
    const accept = req.headers["accept"] || "";
    if (form.redirect_url && accept.includes("text/html")) {
      return reply.code(302).header("Location", form.redirect_url).send();
    }

    return reply.code(201).send({ ok: true, id: rows[0].id });
  });
};

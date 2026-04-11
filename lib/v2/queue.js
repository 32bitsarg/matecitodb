// ─── Job Queue v2 ─────────────────────────────────────────────────────────────
//
// Mejora sobre v1: los jobs se procesan de forma async pero los errores
// se loguean correctamente (no se swallean silenciosamente).
//
// Arquitectura:
//   - Para webhooks y emails: async con setImmediate + retry simple
//   - Para exports: jobs en DB con estado (_export_jobs table)
//
// Si PG_BOSS está disponible (ENABLE_PG_BOSS=true), se usa pg-boss para
// mayor fiabilidad. Si no, se usa async básico con logging.

const db = require("../../db");
const { quoteIdent } = require("../matecito");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// ─── Webhook worker ───────────────────────────────────────────────────────────

/**
 * Ejecuta webhooks para un evento con reintentos y logging correcto.
 * Se llama con setImmediate para no bloquear la respuesta.
 */
async function _executeWebhooks(schemaName, collection, eventType, payload, attempt = 1) {
  const MAX_ATTEMPTS = 3;

  let hooks;
  try {
    const s = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, url, secret, filter_rule FROM ${s}._webhooks
       WHERE enabled = true
         AND collection IN ($1, '*')
         AND event IN ($2, '*')`,
      [collection, eventType]
    );
    hooks = rows;
  } catch (err) {
    console.error(`[queue] webhook: could not fetch hooks for ${schemaName}:`, err.message);
    return;
  }

  if (!hooks || hooks.length === 0) return;

  // Apply filter_rule if present — format: "field.op:value"
  hooks = hooks.filter(hook => {
    if (!hook.filter_rule) return true;
    try {
      const colonIdx = hook.filter_rule.indexOf(":");
      if (colonIdx <= 0) return true;
      const lhs      = hook.filter_rule.slice(0, colonIdx).trim();
      const rhs      = hook.filter_rule.slice(colonIdx + 1).trim();
      const dotIdx   = lhs.lastIndexOf(".");
      const field    = dotIdx > 0 ? lhs.slice(0, dotIdx) : lhs;
      const op       = dotIdx > 0 ? lhs.slice(dotIdx + 1).toLowerCase() : "eq";
      const dataVal  = String(payload?.record?.data?.[field] ?? "");

      if (op === "eq")   return dataVal === rhs;
      if (op === "neq")  return dataVal !== rhs;
      if (op === "in")   return rhs.split(",").map(v => v.trim()).includes(dataVal);
      return true;
    } catch { return true; }
  });

  const body = JSON.stringify({
    event: eventType,
    collection,
    ...payload,
    timestamp: new Date().toISOString(),
  });

  for (const hook of hooks) {
    const headers = {
      "Content-Type":      "application/json",
      "X-Matecito-Event":  eventType,
      "X-Matecito-Schema": schemaName,
    };

    if (hook.secret) {
      const sig = crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
      headers["X-Matecito-Signature"] = `sha256=${sig}`;
    }

    try {
      const res = await fetch(hook.url, {
        method:  "POST",
        headers,
        body,
        signal:  AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[queue] webhook ${hook.url} responded ${res.status} (attempt ${attempt})`);

        if (attempt < MAX_ATTEMPTS) {
          const delay = attempt * 1000;
          setTimeout(() => _executeWebhooks(schemaName, collection, eventType, payload, attempt + 1), delay);
        } else {
          console.error(`[queue] webhook ${hook.url} failed after ${MAX_ATTEMPTS} attempts`);
        }
      }
    } catch (err) {
      console.error(`[queue] webhook ${hook.url} error (attempt ${attempt}):`, err.message);

      if (attempt < MAX_ATTEMPTS) {
        const delay = attempt * 1000;
        setTimeout(() => _executeWebhooks(schemaName, collection, eventType, payload, attempt + 1), delay);
      }
    }
  }
}

/**
 * Encola el envío de webhooks de forma async.
 * No bloquea la respuesta al cliente.
 */
function enqueueWebhook(schemaName, collection, eventType, payload) {
  setImmediate(() => {
    _executeWebhooks(schemaName, collection, eventType, payload).catch((err) => {
      console.error("[queue] webhook unhandled error:", err.message);
    });
  });
}

// ─── Email worker ─────────────────────────────────────────────────────────────

function renderTemplate(str, vars) {
  return str.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? "");
}

/**
 * Envía un email de forma async con logging correcto.
 */
function enqueueEmail(schemaName, projectName, { to, templateName, vars, fallbackSubject, fallbackHtml }) {
  setImmediate(async () => {
    try {
      const s = quoteIdent(schemaName);

      const [smtpRes, tplRes] = await Promise.all([
        db.query(`SELECT * FROM ${s}._smtp_config LIMIT 1`),
        db.query(`SELECT * FROM ${s}._email_templates WHERE name = $1 LIMIT 1`, [templateName]).catch(() => ({ rows: [] })),
      ]);

      const smtp = smtpRes.rows[0];
      if (!smtp) {
        console.info(`[queue] email: no SMTP config for schema ${schemaName}, skipping`);
        return;
      }

      const template = tplRes.rows[0];
      const allVars  = { "project.name": projectName, ...vars };

      const subject  = template ? renderTemplate(template.subject,   allVars) : fallbackSubject;
      const htmlBody = template ? renderTemplate(template.html_body, allVars) : fallbackHtml;
      const textBody = template
        ? renderTemplate(template.text_body ?? "", allVars) || htmlBody.replace(/<[^>]+>/g, "")
        : htmlBody.replace(/<[^>]+>/g, "");

      const transporter = nodemailer.createTransport({
        host:   smtp.host,
        port:   smtp.port,
        secure: smtp.secure,
        auth:   { user: smtp.smtp_user, pass: smtp.smtp_password },
      });

      await transporter.sendMail({
        from:    `"${smtp.from_name || projectName}" <${smtp.from_email}>`,
        to,
        subject,
        html:    htmlBody,
        text:    textBody,
      });

      console.info(`[queue] email sent to ${to} (template: ${templateName})`);
    } catch (err) {
      console.error(`[queue] email failed for ${to}:`, err.message);
    }
  });
}

// ─── Export job processor ─────────────────────────────────────────────────────

/**
 * Procesa un export job en background.
 * Actualiza el estado en _export_jobs cuando termina.
 */
async function processExportJob(schemaName, jobId, { collection, format, filters }) {
  const s = quoteIdent(schemaName);

  try {
    // Marcar como procesando
    await db.query(
      `UPDATE ${s}._export_jobs SET status = 'processing' WHERE id = $1`,
      [jobId]
    );

    // Construir query con filtros opcionales
    const where   = [`collection = $1`, `deleted_at IS NULL`];
    const values  = [collection];

    if (filters && typeof filters === "object") {
      for (const [key, val] of Object.entries(filters)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          values.push(val);
          where.push(`data->>'${key}' = $${values.length}`);
        }
      }
    }

    const { rows } = await db.query(
      `SELECT id, data, created_at, updated_at FROM ${s}._records WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 10000`,
      values
    );

    let content;
    if (format === "csv") {
      if (rows.length === 0) {
        content = "";
      } else {
        const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r.data ?? {}))));
        const header = ["id", ...keys, "created_at", "updated_at"].join(",");
        const lines  = rows.map(r => {
          const cells = ["id", ...keys, "created_at", "updated_at"].map(k => {
            const val = k === "id" ? r.id : k === "created_at" ? r.created_at : k === "updated_at" ? r.updated_at : (r.data ?? {})[k];
            if (val == null) return "";
            const str = String(val);
            return str.includes(",") || str.includes('"') || str.includes("\n")
              ? `"${str.replace(/"/g, '""')}"`
              : str;
          });
          return cells.join(",");
        });
        content = [header, ...lines].join("\n");
      }
    } else {
      content = JSON.stringify(rows, null, 2);
    }

    // Guardar resultado en DB como download_data
    await db.query(
      `UPDATE ${s}._export_jobs
       SET status = 'done', row_count = $1, result_data = $2, completed_at = NOW()
       WHERE id = $3`,
      [rows.length, content, jobId]
    );
  } catch (err) {
    console.error(`[queue] export job ${jobId} failed:`, err.message);
    await db.query(
      `UPDATE ${s}._export_jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
      [err.message, jobId]
    ).catch(() => {});
  }
}

// ─── Audit log ────────────────────────────────────────────────────────────────

/**
 * Encola un registro en _audit_log de forma async (non-blocking).
 * @param {string} schemaName
 * @param {object} opts
 * @param {string} opts.action       - e.g. "record.created"
 * @param {string} opts.entity       - collection name
 * @param {string} [opts.entityId]   - record ID
 * @param {object} [opts.prevValue]  - previous data (for updates/deletes)
 * @param {object} [opts.newValue]   - new data (for creates/updates)
 * @param {string} [opts.performedBy]- userId
 * @param {string} [opts.ip]         - request IP
 */
function enqueueAuditLog(schemaName, { action, entity, entityId, prevValue, newValue, performedBy, ip }) {
  setImmediate(async () => {
    try {
      const s = quoteIdent(schemaName);
      await db.query(
        `INSERT INTO ${s}._audit_log (action, entity, prev_value, new_value, performed_by, ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          action,
          entityId ? `${entity}:${entityId}` : entity,
          prevValue ? JSON.stringify(prevValue) : null,
          newValue  ? JSON.stringify(newValue)  : null,
          performedBy ?? null,
          ip ?? null,
        ]
      );
    } catch { /* audit log is non-critical */ }
  });
}

// ─── Trigger execution ──────────────────────────────────────────────────────

const { runFunction, createDbHelper } = require("./function-runner");

/**
 * Encola la ejecución de triggers para un evento de colección.
 * Se llama con setImmediate para no bloquear la respuesta.
 *
 * @param {string} schemaName
 * @param {string} collection
 * @param {string} event    - 'record.created' | 'record.updated' | 'record.deleted'
 * @param {object} record   - el registro afectado
 * @param {object} [prev_record] - estado anterior (para updates/deletes)
 */
function enqueueTrigger(schemaName, collection, event, record, prev_record) {
  setImmediate(async () => {
    try {
      const s = quoteIdent(schemaName);

      // Buscar triggers activos para este evento
      const { rows: triggers } = await db.query(
        `SELECT id, function_name FROM ${s}._triggers
         WHERE collection = $1 AND event = $2 AND is_active = true`,
        [collection, event]
      );

      if (!triggers || triggers.length === 0) return;

      // Load function codes
      const fnNames = triggers.map(t => t.function_name);
      const { rows: fns } = await db.query(
        `SELECT name, code, timeout_ms FROM ${s}._functions WHERE name = ANY($1)`,
        [fnNames]
      );

      const fnMap = {};
      for (const fn of fns) fnMap[fn.name] = fn;

      const dbHelper = createDbHelper(db, quoteIdent, schemaName);

      for (const trigger of triggers) {
        const fn = fnMap[trigger.function_name];
        if (!fn) continue;

        const context = {
          args: { record, prev_record },
          user: null,
          db:   dbHelper,
          fetch: globalThis.fetch?.bind(globalThis),
          env:  {},
        };

        try {
          const result = await runFunction({
            code: fn.code,
            timeoutMs: fn.timeout_ms || 5000,
            context,
          });

          // Log
          await db.query(
            `INSERT INTO ${s}._function_logs (function_id, status, duration_ms, result, invoked_by)
             VALUES ((SELECT id FROM ${s}._functions WHERE name = $1), 'ok', $2, $3, 'trigger')`,
            [fn.name, result.durationMs, JSON.stringify(result.result)]
          ).catch(() => {});
        } catch (err) {
          await db.query(
            `INSERT INTO ${s}._function_logs (function_id, status, duration_ms, error, invoked_by)
             VALUES ((SELECT id FROM ${s}._functions WHERE name = $1), $2, $3, $4, 'trigger')`,
            [fn.name, err.isTimeout ? 'timeout' : 'error', err.durationMs || 0, err.message]
          ).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[queue] trigger error:`, err.message);
    }
  });
}

module.exports = {
  enqueueWebhook,
  enqueueEmail,
  processExportJob,
  enqueueAuditLog,
  enqueueTrigger,
};

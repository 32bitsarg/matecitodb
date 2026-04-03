const crypto = require("crypto");
const db     = require("../db");
const { quoteIdent } = require("./matecito");

/**
 * Dispara los webhooks registrados para un proyecto/colección/evento.
 * Se llama de forma fire-and-forget — no bloquea la respuesta al cliente.
 *
 * @param {string} schemaName  - Schema del proyecto (ej: "proj_abc123")
 * @param {string} collection  - Nombre de la colección
 * @param {string} eventType   - "record.created" | "record.updated" | "record.deleted"
 * @param {object} payload     - Datos del evento a enviar
 */
async function fireWebhooks(schemaName, collection, eventType, payload) {
  let hooks;
  try {
    const s = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, url, secret FROM ${s}._webhooks
       WHERE enabled = true
         AND collection IN ($1, '*')
         AND event     IN ($2, '*')`,
      [collection, eventType]
    );
    hooks = rows;
  } catch {
    return; // tabla puede no existir en proyectos viejos aún no migrados
  }

  if (!hooks || hooks.length === 0) return;

  const body = JSON.stringify({ event: eventType, collection, ...payload, timestamp: new Date().toISOString() });

  for (const hook of hooks) {
    try {
      const headers = {
        "Content-Type": "application/json",
        "X-Matecito-Event": eventType,
      };

      if (hook.secret) {
        const sig = crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
        headers["X-Matecito-Signature"] = `sha256=${sig}`;
      }

      const res = await fetch(hook.url, {
        method:  "POST",
        headers,
        body,
        signal:  AbortSignal.timeout(8000), // timeout de 8 segundos
      });

      if (!res.ok) {
        console.warn(`[webhook] ${hook.url} respondió ${res.status}`);
      }
    } catch (err) {
      console.warn(`[webhook] Error llamando ${hook.url}: ${err.message}`);
    }
  }
}

module.exports = { fireWebhooks };

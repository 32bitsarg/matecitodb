// ─── Scheduler v2 ─────────────────────────────────────────────────────────────
//
// Jobs internos que corren periódicamente sin necesitar pg-boss.
// Se inicia una vez con startScheduler() desde index.js.
//
// Jobs:
//   Cada 1h   → Borrar _records expirados por schema activo
//   Cada 24h  → Truncar _audit_log según log_retention_days del proyecto
//   Cada 24h  → Limpiar _export_jobs completados con más de 7 días

const db = require("../../db");
const { quoteIdent } = require("../matecito");

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveSchemas() {
  const { rows } = await db.query(
    `SELECT schema_name, log_retention_days FROM projects WHERE schema_name IS NOT NULL ORDER BY created_at`
  );
  return rows;
}

// ── Job: clean expired records ────────────────────────────────────────────────

async function cleanExpiredRecords() {
  let schemas;
  try { schemas = await getActiveSchemas(); } catch { return; }

  for (const { schema_name } of schemas) {
    try {
      const s = quoteIdent(schema_name);
      const { rowCount } = await db.query(
        `DELETE FROM ${s}._records WHERE expires_at IS NOT NULL AND expires_at < NOW()`
      );
      if (rowCount > 0) {
        console.info(`[scheduler] cleaned ${rowCount} expired records from ${schema_name}`);
      }
    } catch { /* schema may not have _records yet */ }
  }
}

// ── Job: trim audit log ───────────────────────────────────────────────────────

async function trimAuditLogs() {
  let schemas;
  try { schemas = await getActiveSchemas(); } catch { return; }

  for (const { schema_name, log_retention_days } of schemas) {
    const retentionDays = Number(log_retention_days ?? 30);
    if (retentionDays <= 0) continue;

    try {
      const s = quoteIdent(schema_name);
      const { rowCount } = await db.query(
        `DELETE FROM ${s}._audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [retentionDays]
      );
      if (rowCount > 0) {
        console.info(`[scheduler] trimmed ${rowCount} audit log entries from ${schema_name}`);
      }
    } catch { /* audit_log may not exist */ }
  }
}

// ── Job: clean old export jobs ────────────────────────────────────────────────

async function cleanExportJobs() {
  let schemas;
  try { schemas = await getActiveSchemas(); } catch { return; }

  for (const { schema_name } of schemas) {
    try {
      const s = quoteIdent(schema_name);
      const { rowCount } = await db.query(
        `DELETE FROM ${s}._export_jobs
         WHERE status IN ('done', 'failed') AND completed_at < NOW() - INTERVAL '7 days'`
      );
      if (rowCount > 0) {
        console.info(`[scheduler] cleaned ${rowCount} old export jobs from ${schema_name}`);
      }
    } catch { /* export_jobs may not exist */ }
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

function runSafe(name, fn) {
  fn().catch(err => console.error(`[scheduler] job '${name}' failed:`, err.message));
}

/**
 * Starts all background cleanup jobs.
 * Call once at server startup.
 */
function startScheduler() {
  // Run immediately on startup (with a short delay to let DB connect)
  setTimeout(() => {
    runSafe("cleanExpiredRecords", cleanExpiredRecords);
    runSafe("trimAuditLogs",      trimAuditLogs);
    runSafe("cleanExportJobs",    cleanExportJobs);
  }, 10_000);

  // Then on schedule
  setInterval(() => runSafe("cleanExpiredRecords", cleanExpiredRecords), HOUR).unref();
  setInterval(() => runSafe("trimAuditLogs",       trimAuditLogs),       DAY).unref();
  setInterval(() => runSafe("cleanExportJobs",     cleanExportJobs),     DAY).unref();

  console.info("[scheduler] started — cleanup jobs registered");
}

module.exports = { startScheduler };

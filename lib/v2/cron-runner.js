// ─── Cron Runner (L1) — Declarative cron jobs ───────────────────────────────
//
// Parser de expresiones cron (5 campos) + loop de ejecución por proyecto.
// Sin dependencias externas.

const db = require("../../db");
const { quoteIdent } = require("../matecito");
const { runFunction, createDbHelper } = require("./function-runner");
const dbModule = require("./auth");

// ── Cron expression parser (5 campos: min hour dom month dow) ──────────────

function parseCronField(field, min, max) {
  if (field === "*") return null; // all values

  const values = new Set();

  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, step] = part.split("/");
      const stepNum = parseInt(step, 10);
      if (isNaN(stepNum) || stepNum < 1) return null;
      const start = range === "*" ? min : parseInt(range, 10);
      for (let i = start; i <= max; i += stepNum) values.add(i);
    } else if (part.includes("-")) {
      const [s, e] = part.split("-").map(Number);
      for (let i = s; i <= e; i++) values.add(i);
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= min && num <= max) values.add(num);
    }
  }

  return values.size > 0 ? values : null;
}

function parseCronExpr(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dom, month, dow] = parts;
  const parsed = {
    minute: parseCronField(minute, 0, 59),
    hour:   parseCronField(hour, 0, 23),
    dom:    parseCronField(dom, 1, 31),
    month:  parseCronField(month, 1, 12),
    dow:    parseCronField(dow, 0, 7), // 0 y 7 = Sunday
  };

  return parsed;
}

/**
 * Verifica si un Date matchea una expresión cron.
 */
function matchesCron(date, parsed) {
  if (!parsed) return false;
  if (parsed.minute && !parsed.minute.has(date.getMinutes())) return false;
  if (parsed.hour   && !parsed.hour.has(date.getHours()))   return false;
  if (parsed.dom    && !parsed.dom.has(date.getDate()))      return false;
  if (parsed.month  && !parsed.month.has(date.getMonth() + 1)) return false;
  if (parsed.dow) {
    const jsDow = date.getDay(); // 0=Sun
    const dowSet = new Set([...parsed.dow].map(d => d === 7 ? 0 : d));
    if (!dowSet.has(jsDow)) return false;
  }
  return true;
}

/**
 * Calcula la próxima ejecución de un cron.
 */
function nextRunAt(cronExpr, fromDate = new Date()) {
  const parsed = parseCronExpr(cronExpr);
  if (!parsed) return null;

  let d = new Date(fromDate);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  for (let i = 0; i < 525960; i++) { // max 1 year of minutes
    if (matchesCron(d, parsed)) return new Date(d);
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ── Cron runner loop ────────────────────────────────────────────────────────

let _cronInterval = null;
const _running = new Set(); // prevent concurrent executions of same cron

async function executeCron(schemaName, cronId, cronName, functionName, projectId) {
  if (_running.has(cronId)) return;
  _running.add(cronId);

  const schema = quoteIdent(schemaName);

  try {
    // Get function
    const { rows: fnRows } = await db.query(
      `SELECT id, name, code, timeout_ms FROM ${schema}._functions WHERE name = $1 LIMIT 1`,
      [functionName]
    );

    if (!fnRows[0]) {
      await db.query(
        `UPDATE ${schema}._crons SET last_run_at = NOW(), next_run_at = $1
         WHERE id = $2`,
        [nextRunAtForUpdate(schemaName, cronId), cronId]
      );
      return;
    }

    const fn = fnRows[0];
    const context = {
      args: { _cron: { name: cronName, scheduled_at: new Date().toISOString() } },
      user: null,
      db: createDbHelper(dbModule.db, quoteIdent, schemaName),
      fetch: globalThis.fetch?.bind(globalThis),
      env: {},
    };

    const result = await runFunction({ code: fn.code, timeoutMs: fn.timeout_ms || 5000, context });

    // Update cron record
    const nextRun = nextRunAtForUpdate(schemaName, cronId);
    await db.query(
      `UPDATE ${schema}._crons SET last_run_at = NOW(), next_run_at = $1 WHERE id = $2`,
      [nextRun, cronId]
    );

    // Log
    await db.query(
      `INSERT INTO ${schema}._function_logs (function_id, status, duration_ms, result, invoked_by)
       VALUES ($1, 'ok', $2, $3, 'cron')`,
      [fn.id, result.durationMs, JSON.stringify(result.result)]
    ).catch(() => {});
  } catch (err) {
    // Log failure
    try {
      const nextRun = nextRunAtForUpdate(schemaName, cronId);
      await db.query(
        `UPDATE ${schema}._crons SET last_run_at = NOW(), next_run_at = $1 WHERE id = $2`,
        [nextRun, cronId]
      );
    } catch { /* ignore */ }
  } finally {
    _running.delete(cronId);
  }
}

function nextRunAtForUpdate(schemaName, cronId) {
  // Will be recalculated by the runner
  return null;
}

async function tick() {
  try {
    const { rows: projects } = await db.query(
      `SELECT id, schema_name FROM projects WHERE schema_name IS NOT NULL`
    );

    const now = new Date();

    for (const project of projects) {
      const schema = quoteIdent(project.schema_name);

      const { rows: crons } = await db.query(
        `SELECT id, name, cron_expr, function_name, is_active, next_run_at
         FROM ${schema}._crons WHERE is_active = true`,
      ).catch(() => ({ rows: [] }));

      for (const cron of crons) {
        const shouldRun = !cron.next_run_at || new Date(cron.next_run_at) <= now;
        if (!shouldRun) continue;

        // Calculate next_run_at if not set
        const nextRun = cron.next_run_at ? null : nextRunAt(cron.cron_expr);

        await db.query(
          `UPDATE ${schema}._crons SET next_run_at = $1 WHERE id = $2`,
          [nextRun, cron.id]
        ).catch(() => {});

        executeCron(project.schema_name, cron.id, cron.name, cron.function_name, project.id);
      }
    }
  } catch (err) {
    console.error("[cron] tick error:", err.message);
  }
}

function startCronRunner() {
  if (_cronInterval) return;
  _cronInterval = setInterval(tick, 60000); // check every 60s
  tick(); // immediate first check
  console.log("[cron] runner started — checking every 60s");
}

function stopCronRunner() {
  if (_cronInterval) {
    clearInterval(_cronInterval);
    _cronInterval = null;
  }
}

module.exports = {
  parseCronExpr,
  nextRunAt,
  matchesCron,
  startCronRunner,
  stopCronRunner,
  tick,
};

// ─── Function Runner (F1) — Sandboxed JS execution ──────────────────────────
//
// Ejecuta código JS de usuario dentro de un sandbox de vm.runInNewContext
// con timeout, contexto limitado y sin acceso a require/process/fs.
//
// Contexto inyectado:
//   { args, user, db, fetch, env }
//
// Seguridad:
//   - vm.runInNewContext con codeGeneration: { strings: false, wasm: false }
//   - Timeout via Promise.race
//   - Sin require, process, fs, __dirname, global
//   - Max código: 50KB, Max resultado: 1MB
//   - Rate limit: 30 invocations / min por proyecto (manejado por route)

const { Script, runInNewContext } = require("vm");

const MAX_CODE_SIZE = 50 * 1024;   // 50KB
const MAX_RESULT_SIZE = 1024 * 1024; // 1MB

/**
 * Ejecuta una function en sandbox.
 *
 * @param {object} opts
 * @param {string} opts.code        - Código JS del usuario
 * @param {number} [opts.timeoutMs] - Timeout en ms (default 5000)
 * @param {object} opts.context     - Contexto inyectado { args, user, db, fetch, env }
 * @returns {Promise<{ result: any, durationMs: number }>}
 */
async function runFunction({ code, timeoutMs = 5000, context }) {
  if (!code || typeof code !== "string") {
    throw new Error("code is required");
  }
  if (code.length > MAX_CODE_SIZE) {
    throw new Error(`Code exceeds maximum size of ${MAX_CODE_SIZE} bytes`);
  }

  // Wrapper: la function del usuario retorna un valor
  const wrapped = `(async () => { ${code} })()`;

  // Contexto seguro: nada de node internals
  const sandbox = {
    args:      context.args || {},
    user:      context.user || null,
    db:        context.db || { query: async () => [], create: async () => null, update: async () => null, delete: async () => null },
    fetch:     context.fetch || globalThis.fetch || (() => { throw new Error("fetch not available"); }),
    env:       context.env || {},
    result:    undefined,
    console:   {
      log:   (...a) => sandbox._logs.push(["log", ...a].map(String).join(" ")),
      info:  (...a) => sandbox._logs.push(["info", ...a].map(String).join(" ")),
      warn:  (...a) => sandbox._logs.push(["warn", ...a].map(String).join(" ")),
      error: (...a) => sandbox._logs.push(["error", ...a].map(String).join(" ")),
    },
    _logs: [],
  };

  // Compile the script
  let script;
  try {
    script = new Script(wrapped, {
      codeGeneration: { strings: false, wasm: false },
    });
  } catch (err) {
    throw new Error(`Compilation error: ${err.message}`);
  }

  // Execute with timeout
  const startTime = Date.now();

  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Function execution timed out")), timeoutMs);
    });

    const execPromise = runInNewContext(
      wrapped,
      sandbox,
      {
        timeout: timeoutMs,
        codeGeneration: { strings: false, wasm: false },
      }
    );

    await Promise.race([execPromise, timeoutPromise]);
  } catch (err) {
    const duration = Date.now() - startTime;
    const isTimeout = err.message.includes("timed out") || err.message.includes("Script execution timed out");
    throw {
      message: err.message,
      isTimeout,
      durationMs: duration,
      logs: sandbox._logs,
    };
  }

  const duration = Date.now() - startTime;

  // Validate result size
  let serialized;
  try {
    serialized = JSON.stringify(sandbox.result);
  } catch {
    throw new Error("Function returned a non-serializable value");
  }

  if (serialized && serialized.length > MAX_RESULT_SIZE) {
    throw new Error(`Result exceeds maximum size of ${MAX_RESULT_SIZE} bytes`);
  }

  return {
    result: sandbox.result,
    durationMs: duration,
    logs: sandbox._logs,
  };
}

/**
 * Construye el contexto de DB para inyectar en el sandbox.
 * Cada método opera sobre el schema del proyecto.
 */
function createDbHelper(db, quoteIdent, schemaName) {
  const s = quoteIdent(schemaName);

  return {
    query: async (collection, filter = {}) => {
      const where = [`collection = $1`];
      const values = [collection];
      let idx = 2;

      for (const [key, val] of Object.entries(filter)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          values.push(val);
          where.push(`data->>'${key}' = $${idx++}`);
        }
      }

      const { rows } = await db.query(
        `SELECT * FROM ${s}._records WHERE ${where.join(" AND ")} LIMIT 1000`,
        values
      );
      return rows.map(r => ({ id: r.id, data: r.data, created_at: r.created_at, updated_at: r.updated_at }));
    },

    create: async (collection, data) => {
      const { rows } = await db.query(
        `INSERT INTO ${s}._records (collection, data) VALUES ($1, $2) RETURNING *`,
        [collection, JSON.stringify(data)]
      );
      return rows[0] ? { id: rows[0].id, data: rows[0].data } : null;
    },

    update: async (collection, id, data) => {
      const { rows } = await db.query(
        `UPDATE ${s}._records SET data = data || $1::jsonb, updated_at = NOW()
         WHERE collection = $2 AND id = $3 RETURNING *`,
        [JSON.stringify(data), collection, id]
      );
      return rows[0] ? { id: rows[0].id, data: rows[0].data } : null;
    },

    delete: async (collection, id) => {
      await db.query(
        `DELETE FROM ${s}._records WHERE collection = $1 AND id = $2`,
        [collection, id]
      );
    },
  };
}

module.exports = {
  runFunction,
  createDbHelper,
  MAX_CODE_SIZE,
  MAX_RESULT_SIZE,
};

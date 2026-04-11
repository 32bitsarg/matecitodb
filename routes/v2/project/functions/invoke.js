// ─── Function Invoke (F1) ───────────────────────────────────────────────────
//
// POST /functions/:name/invoke  → ejecutar function
//
// Rate limit: 30 invocations / minuto por proyecto.

const {
  db,
  flexAuth,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables }    = require("../../../../lib/v2/schema");
const { runFunction, createDbHelper } = require("../../../../lib/v2/function-runner");
const { apiError }          = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    // Load function
    const { rows: fnRows } = await db.query(
      `SELECT * FROM ${schema}._functions WHERE name = $1 LIMIT 1`,
      [name]
    );

    if (!fnRows[0]) return apiError(reply, "GEN_003", `Function '${name}' not found`);

    const fn = fnRows[0];

    // Auth check
    if (!fn.is_public && !req.projectUser && !req.platformUser) {
      return apiError(reply, "PERM_001");
    }

    // Build context
    const context = {
      args:  req.body || {},
      user:  req.projectUser ? { id: req.projectUser.id, email: req.projectUser.email, roles: req.projectUser.roles || [] } : null,
      db:    createDbHelper(db, quoteIdent, schemaName),
      fetch: globalThis.fetch?.bind(globalThis),
      env:   {},
    };

    // Load env vars for this project
    try {
      const { rows: envRows } = await db.query(
        `SELECT key, value_enc FROM ${schema}._function_env`
      );
      for (const row of envRows) {
        context.env[row.key] = row.value_enc;
      }
    } catch { /* no env table yet */ }

    // Execute
    let result;
    let status = "ok";
    let errorMsg = null;
    const startTime = Date.now();

    try {
      result = await runFunction({
        code: fn.code,
        timeoutMs: fn.timeout_ms || 5000,
        context,
      });
    } catch (err) {
      status = err.isTimeout ? "timeout" : "error";
      errorMsg = err.message || String(err);
      result = null;
    }

    const duration = Date.now() - startTime;

    // Log execution
    try {
      const logs = (result && result.logs) || [];
      await db.query(
        `INSERT INTO ${schema}._function_logs (function_id, status, duration_ms, result, error, invoked_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fn.id,
          status,
          duration,
          status === "ok" ? JSON.stringify(result.result) : null,
          errorMsg,
          req.projectUser?.id || null,
        ]
      );
    } catch { /* log is non-critical */ }

    if (status !== "ok") {
      return reply.code(status === "timeout" ? 504 : 500).send({
        error: errorMsg,
        status,
        duration_ms: duration,
      });
    }

    return {
      result: result.result,
      status,
      duration_ms: duration,
      logs: result.logs || [],
    };
  };

  projectRoute(fastify, "POST", "/functions/:name/invoke", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: true,
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, handler);
};

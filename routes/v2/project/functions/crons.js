// ─── Cron Jobs CRUD (L1) ───────────────────────────────────────────────────
//
// GET    /functions/crons              → listar
// POST   /functions/crons              → crear
// PATCH  /functions/crons/:name        → actualizar
// DELETE /functions/crons/:name        → eliminar
// POST   /functions/crons/:name/run    → ejecutar manualmente

const {
  db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const { nextRunAt }      = require("../../../../lib/v2/cron-runner");
const { runFunction, createDbHelper } = require("../../../../lib/v2/function-runner");
const dbModule = require("../../../../lib/v2/auth");

module.exports = async function (fastify) {
  // GET /functions/crons
  fastify.get("/functions/crons", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._crons ORDER BY created_at DESC`);
    return { crons: rows };
  });

  // POST /functions/crons
  fastify.post("/functions/crons", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["name","cron_expr","function_name"], properties: { name: { type: "string" }, cron_expr: { type: "string" }, function_name: { type: "string" }, timezone: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name, cron_expr, function_name, timezone = "UTC" } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    // Verify function exists
    const { rows: fnRows } = await db.query(`SELECT 1 FROM ${schema}._functions WHERE name = $1`, [function_name]);
    if (!fnRows[0]) return reply.code(400).send({ error: `Function '${function_name}' not found` });
    const nextRun = nextRunAt(cron_expr);
    try {
      const { rows } = await db.query(`INSERT INTO ${schema}._crons (name, cron_expr, function_name, timezone, next_run_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [name, cron_expr, function_name, timezone, nextRun]);
      return reply.code(201).send({ cron: rows[0] });
    } catch (err) {
      if (err.code === "23505") return reply.code(409).send({ error: `Cron '${name}' already exists` });
      throw err;
    }
  });

  // PATCH /functions/crons/:name
  fastify.patch("/functions/crons/:name", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", properties: { cron_expr: { type: "string" }, function_name: { type: "string" }, timezone: { type: "string" }, is_active: { type: "boolean" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const { cron_expr, function_name, timezone, is_active } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const updates = []; const values = [];
    if (cron_expr !== undefined) { values.push(cron_expr); updates.push(`cron_expr=$${values.length}`); }
    if (function_name !== undefined) { values.push(function_name); updates.push(`function_name=$${values.length}`); }
    if (timezone !== undefined) { values.push(timezone); updates.push(`timezone=$${values.length}`); }
    if (is_active !== undefined) { values.push(is_active); updates.push(`is_active=$${values.length}`); }
    if (!updates.length) return reply.code(400).send({ error: "No fields to update" });
    values.push(name);
    const { rows } = await db.query(`UPDATE ${schema}._crons SET ${updates.join(",")} WHERE name=$${values.length} RETURNING *`, values);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { cron: rows[0] };
  });

  // DELETE /functions/crons/:name
  fastify.delete("/functions/crons/:name", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._crons WHERE name=$1`, [name]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { deleted: name };
  });

  // POST /functions/crons/:name/run
  fastify.post("/functions/crons/:name/run", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${schema}._crons WHERE name=$1`, [name]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    const cron = rows[0];
    const { rows: fnRows } = await db.query(`SELECT * FROM ${schema}._functions WHERE name=$1`, [cron.function_name]);
    if (!fnRows[0]) return reply.code(400).send({ error: "Function not found" });
    const fn = fnRows[0];
    const context = { args: { _cron: { name: cron.name, manual: true } }, user: null, db: createDbHelper(dbModule.db, quoteIdent, schemaName), fetch: globalThis.fetch?.bind(globalThis), env: {} };
    const start = Date.now();
    try {
      const result = await runFunction({ code: fn.code, timeoutMs: fn.timeout_ms || 5000, context });
      await db.query(`UPDATE ${schema}._crons SET last_run_at=NOW() WHERE id=$1`, [cron.id]);
      return { result: result.result, duration_ms: Date.now() - start };
    } catch (err) {
      return reply.code(500).send({ error: err.message, duration_ms: Date.now() - start });
    }
  });
};

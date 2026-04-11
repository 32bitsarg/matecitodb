// ─── Sync Offline Lite (O2) ────────────────────────────────────────────────
//
// GET  /records/sync          → delta sync desde timestamp
// POST /records/sync/push     → push de cambios offline

const { db, flexAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // GET /records/sync
  fastify.get("/records/sync", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, since, limit = "500" } = req.query;
    if (!collection) return reply.code(400).send({ error: "collection required" });
    if (!since) return reply.code(400).send({ error: "since timestamp required" });

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const sinceDate = new Date(parseInt(since, 10));
    if (isNaN(sinceDate.getTime())) return reply.code(400).send({ error: "Invalid since timestamp" });

    const limitNum = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));
    const { rows } = await db.query(`SELECT id, data, updated_at, deleted_at FROM ${schema}._records WHERE collection = $1 AND updated_at > $2 ORDER BY updated_at ASC LIMIT $3`, [collection, sinceDate, limitNum]);

    const created = rows.filter(r => !r.deleted_at && new Date(r.updated_at).getTime() - new Date(r.created_at || r.updated_at).getTime() < 5000);
    const updated = rows.filter(r => !r.deleted_at && !created.includes(r));
    const deleted = rows.filter(r => r.deleted_at);

    return { collection, since: parseInt(since, 10), server_time: Date.now(), has_more: rows.length === limitNum, changes: { created: created.map(r => ({ id: r.id, data: r.data, updated_at: r.updated_at })), updated: updated.map(r => ({ id: r.id, data: r.data, updated_at: r.updated_at })), deleted: deleted.map(r => r.id) } };
  });

  // POST /records/sync/push
  fastify.post("/records/sync/push", { preHandler: flexAuth, schema: { body: { type: "object", required: ["collection", "changes"], properties: { collection: { type: "string" }, conflict_strategy: { type: "string" }, changes: { type: "array" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, changes, conflict_strategy = "last_write_wins" } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const perm = await checkPermissionV2(schemaName, collection, "create", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const results = [];
    const conflicts = [];

    for (const change of changes) {
      try {
        if (change.op === "create") {
          const { rows } = await db.query(`INSERT INTO ${schema}._records (collection, data) VALUES ($1, $2) RETURNING id`, [collection, JSON.stringify(change.data)]);
          results.push({ local_id: change.local_id, server_id: rows[0].id, status: "created" });
        } else if (change.op === "update") {
          if (conflict_strategy === "last_write_wins") {
            const { rows } = await db.query(`UPDATE ${schema}._records SET data = data || $1::jsonb, updated_at = NOW() WHERE id = $2 AND collection = $3 RETURNING id, updated_at`, [JSON.stringify(change.data), change.id, collection]);
            if (rows[0]) results.push({ id: change.id, status: "updated" });
            else results.push({ id: change.id, status: "not_found" });
          } else if (conflict_strategy === "server_wins") {
            const { rows } = await db.query(`SELECT updated_at FROM ${schema}._records WHERE id = $1`, [change.id]);
            if (rows[0] && new Date(rows[0].updated_at) > new Date(change.client_ts)) {
              conflicts.push({ id: change.id, reason: "server_updated_after_client", server_updated_at: rows[0].updated_at });
            } else {
              await db.query(`UPDATE ${schema}._records SET data = data || $1::jsonb, updated_at = NOW() WHERE id = $2 AND collection = $3`, [JSON.stringify(change.data), change.id, collection]);
              results.push({ id: change.id, status: "updated" });
            }
          }
        } else if (change.op === "delete") {
          await db.query(`DELETE FROM ${schema}._records WHERE id = $1 AND collection = $2`, [change.id, collection]);
          results.push({ id: change.id, status: "deleted" });
        }
      } catch (err) {
        results.push({ id: change.id || change.local_id, status: "error", error: err.message });
      }
    }

    return { results, conflicts, server_time: Date.now() };
  });
};

// ─── Query Explain (R3) ────────────────────────────────────────────────────
//
// POST /records/explain → EXPLAIN ANALYZE de una query

const { db, requireProjectApiKey, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.post("/records/explain", { preHandler: requireProjectApiKey(["service"]), schema: { body: { type: "object", required: ["collection"], properties: { collection: { type: "string" }, filter: { type: "string" }, sort: { type: "string" }, order: { type: "string" }, limit: { type: "integer" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, filter, sort = "created_at", order = "desc", limit = 50 } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);

    const where = [`r.collection = $1`, `r.deleted_at IS NULL`];
    const values = [collection];
    if (filter) {
      const pairs = filter.split("&");
      for (const p of pairs) {
        const colonIdx = p.indexOf(":");
        if (colonIdx <= 0) continue;
        const [key, opVal] = [p.slice(0, colonIdx), p.slice(colonIdx + 1)];
        const dotIdx = opVal.indexOf(".");
        if (dotIdx <= 0) continue;
        const [op, val] = [opVal.slice(0, dotIdx), opVal.slice(dotIdx + 1)];
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) { values.push(val); where.push(`r.data->>'${key}' = $${values.length}`); }
      }
    }

    const orderDir = order.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const sql = `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON) SELECT r.* FROM ${schema}._records r WHERE ${where.join(" AND ")} ORDER BY r.${sort} ${orderDir} LIMIT $${values.length + 1}`;
    values.push(limit);

    try {
      const { rows } = await db.query(sql, values);
      const plan = rows[0]?.["QUERY PLAN"];
      const planText = typeof plan === "string" ? plan : JSON.stringify(plan);

      const warnings = [];
      const suggestions = [];
      if (planText.toLowerCase().includes("seq scan")) { warnings.push("Sequential scan detected — consider adding an index"); suggestions.push(`CREATE INDEX ON ${schemaName}._records (collection, created_at DESC) WHERE deleted_at IS NULL`); }
      if (!planText.toLowerCase().includes("bitmap") && !planText.toLowerCase().includes("index")) { suggestions.push("Consider adding a GIN index on data for filtered fields"); }

      return { collection, plan_type: planText.toLowerCase().includes("seq scan") ? "Sequential Scan" : "Index Scan", uses_index: !planText.toLowerCase().includes("seq scan"), warnings, suggestions, raw_plan: planText };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
};

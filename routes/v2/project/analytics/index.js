// ─── Event Analytics (I2) ──────────────────────────────────────────────────
//
// POST /analytics/track          → track event
// GET  /analytics/events         → agregación por evento/fecha
// GET  /analytics/funnel         → funnel de conversión
// GET  /analytics/users/:id/events → eventos de un usuario
//
// Tabla: _analytics_events
// Rate limit: 1000 eventos/minuto por proyecto

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // ── POST /analytics/track ──────────────────────────────────────────────
  fastify.post("/analytics/track", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["event"],
        properties: {
          event:       { type: "string", minLength: 1 },
          session_id:  { type: "string" },
          user_id:     { type: "string" },
          properties:  { type: "object" },
        },
      },
    },
    config: { rateLimit: { max: 1000, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { event, session_id, user_id, properties } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    await db.query(
      `INSERT INTO ${schema}._analytics_events (event, user_id, session_id, properties, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event,
        user_id || req.projectUser?.id || null,
        session_id || null,
        JSON.stringify(properties || {}),
        req.ip || null,
        req.headers["user-agent"] || null,
      ]
    );

    return reply.code(204).send();
  });

  // ── GET /analytics/events ──────────────────────────────────────────────
  fastify.get("/analytics/events", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { from, to, group_by = "event", event } = req.query;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const where = [];
    const values = [];

    if (from) { values.push(from); where.push(`created_at >= $${values.length}`); }
    if (to)   { values.push(to);   where.push(`created_at <= $${values.length}`); }
    if (event) { values.push(event); where.push(`event = $${values.length}`); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    let groupExpr = "event";
    if (group_by === "properties") {
      // Group by top-level property key
      groupExpr = "properties::text";
    }

    const { rows } = await db.query(
      `SELECT ${groupExpr} AS group_key,
              COUNT(*) AS count,
              COUNT(DISTINCT user_id) AS unique_users,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen
       FROM ${schema}._analytics_events
       ${whereClause}
       GROUP BY ${groupExpr}
       ORDER BY count DESC
       LIMIT 100`,
      values
    );

    return {
      from: from || null,
      to: to || null,
      group_by,
      results: rows.map(r => ({
        event: r.group_key,
        count: parseInt(r.count, 10),
        unique_users: parseInt(r.unique_users, 10),
        first_seen: r.first_seen,
        last_seen: r.last_seen,
      })),
    };
  });

  // ── GET /analytics/funnel ──────────────────────────────────────────────
  fastify.get("/analytics/funnel", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { steps, from, to } = req.query;

    if (!steps) return reply.code(400).send({ error: "steps query param required", code: "GEN_002" });

    const stepList = Array.isArray(steps) ? steps : [steps];
    if (stepList.length === 0) return reply.code(400).send({ error: "At least one step required", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const where = [];
    const values = [];

    if (from) { values.push(from); where.push(`created_at >= $${values.length}`); }
    if (to)   { values.push(to);   where.push(`created_at <= $${values.length}`); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const stepsIn = stepList.map((_, i) => `$${i + 1}`).join(",");
    stepList.forEach(s => values.push(s));

    // Funnel: count unique users per step
    const { rows } = await db.query(
      `SELECT event, COUNT(DISTINCT user_id) AS users, COUNT(*) AS events
       FROM ${schema}._analytics_events
       ${whereClause}
       AND event IN (${stepsIn})
       GROUP BY event
       ORDER BY array_position(ARRAY[${stepList.map((_, i) => `$${i + 1}`).join(",")}], event)`,
      [...values, ...stepList]
    );

    const funnel = stepList.map(step => {
      const row = rows.find(r => r.event === step);
      return {
        step,
        users: row ? parseInt(row.users, 10) : 0,
        events: row ? parseInt(row.events, 10) : 0,
      };
    });

    // Calculate conversion rates
    const firstUsers = funnel[0]?.users || 1;
    for (let i = 0; i < funnel.length; i++) {
      funnel[i].conversion_rate = (funnel[i].users / firstUsers * 100).toFixed(2);
    }

    return {
      from: from || null,
      to: to || null,
      funnel,
    };
  });

  // ── GET /analytics/users/:userId/events ────────────────────────────────
  fastify.get("/analytics/users/:userId/events", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { userId } = req.params;
    const { limit = "50" } = req.query;

    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, event, session_id, properties, ip, user_agent, created_at
       FROM ${schema}._analytics_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limitNum]
    );

    return {
      user_id: userId,
      events: rows,
      total: rows.length,
    };
  });
};

// ─── Geo Queries (M1) ──────────────────────────────────────────────────────
//
// GET  /records/geo/nearby       → buscar cerca de un punto
// GET  /records/geo/bounds       → dentro de un bounding box
// POST /records/geo/batch-distance → distancia a múltiples registros

const { db, flexAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const { validateGeopoint, boundingBoxSql } = require("../../../../lib/v2/geo");

module.exports = async function (fastify) {
  // GET /records/geo/nearby
  fastify.get("/records/geo/nearby", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, lat, lng, radius_km = "5", limit = "20" } = req.query;

    if (!collection) return reply.code(400).send({ error: "collection required" });
    const vp = validateGeopoint(lat, lng);
    if (!vp.valid) return reply.code(400).send({ error: vp.error });

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const radius = parseFloat(radius_km);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
    const box = boundingBoxSql(vp.lat, vp.lng, radius);

    const where = [`r.collection = $1`, `r.data->>'_lat' IS NOT NULL`, `r.data->>'_lng' IS NOT NULL`, `(r.data->>'_lat')::float BETWEEN $2 AND $3`, `(r.data->>'_lng')::float BETWEEN $4 AND $5`];
    if (req.query.include_deleted !== "true") where.push(`r.deleted_at IS NULL`);
    const values = [collection, box.latMin, box.latMax, box.lngMin, box.lngMax];

    if (perm.filterSql) { let i = values.length; values.push(...perm.filterValues); where.push(perm.filterSql.replace(/\$\?/g, () => `$${++i}`)); }

    const distExpr = `6371 * 2 * ASIN(SQRT(POWER(SIN(RADIANS($6::float - (r.data->>'_lat')::float) / 2)), 2) + COS(RADIANS($6::float)) * COS(RADIANS((r.data->>'_lat')::float)) * POWER(SIN(RADIANS($7::float - (r.data->>'_lng')::float) / 2)), 2)))`;
    values.push(vp.lat, vp.lng, radius, limitNum);

    const { rows } = await db.query(
      `SELECT r.id, r.data, ${distExpr} AS distance_km FROM ${schema}._records r WHERE ${where.join(" AND ")} HAVING distance_km <= $8 ORDER BY distance_km LIMIT $9`,
      values
    );

    return { collection, origin: { lat: vp.lat, lng: vp.lng }, radius_km: radius, total: rows.length, results: rows.map(r => ({ id: r.id, distance_km: parseFloat(r.distance_km), data: r.data })) };
  });

  // GET /records/geo/bounds
  fastify.get("/records/geo/bounds", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, north, south, east, west } = req.query;

    if (!collection) return reply.code(400).send({ error: "collection required" });
    if ([north, south, east, west].some(v => v === undefined)) return reply.code(400).send({ error: "north, south, east, west required" });

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const where = [`r.collection = $1`, `(r.data->>'_lat')::float BETWEEN $2 AND $3`, `(r.data->>'_lng')::float BETWEEN $4 AND $5`];
    const values = [collection, south, north, west, east];
    if (perm.filterSql) { let i = values.length; values.push(...perm.filterValues); where.push(perm.filterSql.replace(/\$\?/g, () => `$${++i}`)); }

    const { rows } = await db.query(`SELECT r.id, r.data FROM ${schema}._records r WHERE ${where.join(" AND ")} LIMIT 500`, values);
    return { collection, bounds: { north, south, east, west }, total: rows.length, results: rows };
  });

  // POST /records/geo/batch-distance
  fastify.post("/records/geo/batch-distance", { preHandler: flexAuth, schema: { body: { type: "object", required: ["collection", "origin", "ids"], properties: { collection: { type: "string" }, origin: { type: "object" }, ids: { type: "array" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, origin, ids } = req.body;
    const vp = validateGeopoint(origin.lat, origin.lng);
    if (!vp.valid) return reply.code(400).send({ error: vp.error });

    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
    const { rows } = await db.query(`SELECT id, data, data->>'_lat' AS lat, data->>'_lng' AS lng FROM ${schema}._records WHERE collection = $1 AND id IN (${placeholders}) AND data->>'_lat' IS NOT NULL`, [collection, ...ids]);
    const { haversineDistance } = require("../../../../lib/v2/geo");
    const results = rows.map(r => ({ id: r.id, distance_km: parseFloat(haversineDistance(vp.lat, vp.lng, parseFloat(r.lat), parseFloat(r.lng)).toFixed(3)), data: r.data }));
    return { results };
  });
};

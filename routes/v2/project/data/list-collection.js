const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const includeRaw = String(req.query?.include || "");
    const include    = new Set(includeRaw.split(",").map(s => s.trim()).filter(Boolean));
    const withFields = include.has("fields");
    const withCounts = include.has("counts");
    const withPerms  = include.has("permissions");

    const queries = [db.query(`SELECT * FROM ${schema}._collections ORDER BY created_at DESC`)];
    if (withFields) queries.push(db.query(`SELECT * FROM ${schema}._fields ORDER BY created_at ASC`));
    if (withCounts) queries.push(db.query(`SELECT collection, COUNT(*)::int AS count FROM ${schema}._records GROUP BY collection`));
    if (withPerms)  queries.push(db.query(`SELECT * FROM ${schema}._permissions`));

    const results = await Promise.all(queries);

    const collectionsResult = results[0];
    let idx = 1;
    const fieldsResult  = withFields ? results[idx++] : null;
    const countsResult  = withCounts ? results[idx++] : null;
    const permsResult   = withPerms  ? results[idx++] : null;

    const fieldsByCollection = {};
    if (withFields && fieldsResult) {
      for (const f of fieldsResult.rows) {
        if (!fieldsByCollection[f.collection]) fieldsByCollection[f.collection] = [];
        fieldsByCollection[f.collection].push(f);
      }
    }

    const countsByCollection = {};
    if (withCounts && countsResult) {
      for (const row of countsResult.rows) countsByCollection[row.collection] = row.count;
    }

    const permsByCollection = {};
    if (withPerms && permsResult) {
      for (const p of permsResult.rows) {
        if (!permsByCollection[p.collection]) permsByCollection[p.collection] = {};
        permsByCollection[p.collection][p.operation] = p.access;
      }
    }

    const collections = collectionsResult.rows.map(col => {
      const base = { name: col.name, soft_delete: col.soft_delete, created_at: col.created_at };
      if (withFields) { base.fields = fieldsByCollection[col.name] ?? []; base.fields_count = base.fields.length; }
      if (withCounts) base.records_count = countsByCollection[col.name] ?? 0;
      if (withPerms)  base.permissions   = permsByCollection[col.name]  ?? {};
      return base;
    });

    return { collections, meta: { total: collections.length, includes: [...include] } };
  };

  projectRoute(fastify, "GET", "/collections", { preHandler: requireProjectOrPlatformAuth }, handler);
};

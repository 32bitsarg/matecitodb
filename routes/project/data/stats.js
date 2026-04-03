const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/stats", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const [users, collections, records, dbSize, storageRes, projectRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM ${s}._auth_users`),
      db.query(`SELECT COUNT(*)::int AS count FROM ${s}._collections`),
      db.query(`SELECT COUNT(*)::int AS count FROM ${s}._records WHERE (expires_at IS NULL OR expires_at > NOW())`),
      db.query(`
        SELECT pg_size_pretty(
          COALESCE(SUM(pg_total_relation_size(c.oid)), 0)
        ) AS size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
      `, [schemaName]),
      // Storage: uso y cuota
      db.query(`SELECT COALESCE(SUM(size), 0)::bigint AS used_bytes FROM files WHERE project_id = $1`, [projectId]),
      db.query(`SELECT storage_quota_mb, log_retention_days, sql_enabled FROM projects WHERE id = $1 LIMIT 1`, [projectId]),
    ]);

    const usedBytes = Number(storageRes.rows[0].used_bytes);
    const quotaMb   = Number(projectRes.rows[0]?.storage_quota_mb ?? 250);

    return {
      users_count:       users.rows[0].count,
      collections_count: collections.rows[0].count,
      records_count:     records.rows[0].count,
      db_size:           dbSize.rows[0].size ?? "0 B",
      storage: {
        used_bytes:   usedBytes,
        used_mb:      parseFloat((usedBytes / 1024 / 1024).toFixed(2)),
        quota_mb:     quotaMb,
        available_mb: parseFloat(((quotaMb * 1024 * 1024 - usedBytes) / 1024 / 1024).toFixed(2)),
        percent_used: quotaMb > 0
          ? parseFloat(((usedBytes / (quotaMb * 1024 * 1024)) * 100).toFixed(1))
          : 0,
      },
      settings: {
        log_retention_days: projectRes.rows[0]?.log_retention_days ?? 30,
        sql_enabled:        projectRes.rows[0]?.sql_enabled ?? false,
      },
    };
  });
};

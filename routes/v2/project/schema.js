const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/schema", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);

    const [projectRes, collectionsRes, fieldsRes, permsRes, oauthRes, settingsRes] = await Promise.all([
      db.query(
        `SELECT id, name, storage_quota_mb, log_retention_days, sql_enabled, allowed_origins FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      ),
      db.query(`SELECT name, soft_delete, created_at FROM ${s}._collections ORDER BY name`),
      db.query(`SELECT collection, name, type, required, options, constraints FROM ${s}._fields ORDER BY collection, name`),
      db.query(`SELECT collection, operation, access, filter_rule FROM ${s}._permissions`),
      db.query(`SELECT provider, enabled FROM ${s}._oauth_providers WHERE enabled = true`).catch(() => ({ rows: [] })),
      db.query(`SELECT magic_link_enabled, totp_enabled FROM ${s}._auth_settings LIMIT 1`).catch(() => ({ rows: [] })),
    ]);

    const proj = projectRes.rows[0];
    if (!proj) return apiError(reply, "GEN_003", "Project not found");

    // Group fields and permissions by collection
    const fieldsByCollection = {};
    for (const f of fieldsRes.rows) {
      if (!fieldsByCollection[f.collection]) fieldsByCollection[f.collection] = [];
      fieldsByCollection[f.collection].push({
        name:        f.name,
        type:        f.type,
        required:    f.required,
        options:     f.options,
        constraints: f.constraints,
      });
    }

    const permsByCollection = {};
    for (const p of permsRes.rows) {
      if (!permsByCollection[p.collection]) permsByCollection[p.collection] = {};
      permsByCollection[p.collection][p.operation] = {
        access:      p.access,
        filter_rule: p.filter_rule ?? null,
      };
    }

    const collections = collectionsRes.rows.map(col => ({
      name:        col.name,
      soft_delete: col.soft_delete,
      fields:      fieldsByCollection[col.name] ?? [],
      permissions: permsByCollection[col.name]  ?? {},
    }));

    const authSettings = settingsRes.rows[0] ?? {};

    return {
      project: {
        id:                 proj.id,
        name:               proj.name,
        storage_quota_mb:   proj.storage_quota_mb,
        log_retention_days: proj.log_retention_days,
        sql_enabled:        proj.sql_enabled,
        allowed_origins:    proj.allowed_origins,
      },
      collections,
      auth: {
        providers:    oauthRes.rows.map(r => r.provider),
        magic_link:   authSettings.magic_link_enabled ?? false,
        totp:         authSettings.totp_enabled       ?? false,
      },
    };
  });
};

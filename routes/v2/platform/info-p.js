const { db, requirePlatformAuth, isProjectMember } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.get("/info-p/:projectId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId        = req.user.id;
    const { projectId } = req.params;

    const membership = await isProjectMember(userId, projectId);
    if (!membership) return apiError(reply, "PERM_001");

    const [projectRes, keysRes] = await Promise.all([
      db.query(
        `SELECT id, workspace_id, name, subdomain, schema_name, storage_quota_mb, log_retention_days, sql_enabled, allowed_origins, created_at
         FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      ),
      db.query(
        `SELECT id, key, type, scopes, created_at, last_used_at FROM api_keys
         WHERE project_id = $1 AND revoked_at IS NULL ORDER BY type ASC`,
        [projectId]
      ),
    ]);

    if (!projectRes.rows[0]) return apiError(reply, "PROJ_001");

    const project = projectRes.rows[0];
    return {
      project: { ...project, url: `https://${project.subdomain}.${DOMAIN}` },
      api_keys: keysRes.rows,
    };
  });
};

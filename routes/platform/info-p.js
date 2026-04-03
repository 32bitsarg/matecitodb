const { db, requirePlatformAuth, isProjectMember } = require("../../lib/matecito");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.get("/info-p/:projectId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId    = req.user.id;
    const { projectId } = req.params;

    const membership = await isProjectMember(userId, projectId);
    if (!membership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const [projectRes, keysRes] = await Promise.all([
      db.query(
        `SELECT id, workspace_id, name, subdomain, schema_name, allow_public_signup, created_at
         FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      ),
      db.query(
        `SELECT id, key, type, label, created_at, last_used_at
         FROM api_keys
         WHERE project_id = $1 AND revoked_at IS NULL
         ORDER BY type ASC`,
        [projectId]
      ),
    ]);

    if (!projectRes.rows[0]) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const project = projectRes.rows[0];

    return {
      project: {
        ...project,
        url: `https://${project.subdomain}.${DOMAIN}`,
      },
      api_keys: keysRes.rows,
    };
  });
};

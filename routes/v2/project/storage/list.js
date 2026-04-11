const {
  db,
  requireProjectOrPlatformAuth,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!project) {
      const { rows } = await db.query(`SELECT id FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
      if (!rows[0]) return apiError(reply, "GEN_003", "Project not found");
    }

    const { rows } = await db.query(
      `SELECT id, project_id, url, mime, size, width, height, variant, created_at
       FROM files WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId]
    );
    return { files: rows };
  };

  projectRoute(fastify, "GET", "/storage", { preHandler: requireProjectOrPlatformAuth }, handler);
};

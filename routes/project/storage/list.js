const { db, requireProjectOrPlatformAuth, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!project) {
      const projectRes = await db.query(
        `SELECT id FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      if (!projectRes.rows[0]) {
        return reply.code(404).send({ error: "Project not found" });
      }
    }

    const result = await db.query(
      `SELECT id, project_id, url, mime, size, width, height, variant, created_at
       FROM files
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    );

    return { files: result.rows };
  };

  projectRoute(fastify, "GET", "/storage", { preHandler: requireProjectOrPlatformAuth }, handler);
};

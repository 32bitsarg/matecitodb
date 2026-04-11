const fs = require("fs/promises");
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
    const { fileId } = req.params;

    const { rows } = await db.query(
      `SELECT id, storage_path FROM files WHERE id = $1 AND project_id = $2 LIMIT 1`,
      [fileId, projectId]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "File not found");

    if (rows[0].storage_path) {
      await fs.unlink(rows[0].storage_path).catch(() => {});
    }

    await db.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    return { ok: true };
  };

  projectRoute(fastify, "DELETE", "/storage/:fileId", { preHandler: requireProjectOrPlatformAuth }, handler);
};

const fs   = require("fs/promises");
const { db, requireProjectOrPlatformAuth, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { fileId } = req.params;

    const fileRes = await db.query(
      `SELECT id, storage_path FROM files WHERE id = $1 AND project_id = $2 LIMIT 1`,
      [fileId, projectId]
    );
    const file = fileRes.rows[0];
    if (!file) {
      return reply.code(404).send({ error: "File not found" });
    }

    // Eliminar del disco (async, no bloquea el event loop)
    if (file.storage_path) {
      await fs.unlink(file.storage_path).catch(() => {
        // Si el archivo ya no existe en disco, continuar igual
      });
    }

    await db.query(`DELETE FROM files WHERE id = $1`, [fileId]);

    return { ok: true };
  };

  projectRoute(fastify, "DELETE", "/storage/:fileId", { preHandler: requireProjectOrPlatformAuth }, handler);
};

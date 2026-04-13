const fs   = require("fs");
const {
  db,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // Public file serve — no auth required.
  // Uses file UUID so URLs are unguessable and don't expose projectId.
  // When accessed via subdomain, ownership is verified against resolvedProject.
  projectRoute(fastify, "GET", "/storage/files/:fileId", {}, async (req, reply) => {
    const resolvedProjectId = req.resolvedProject?.id ?? null;
    const { fileId } = req.params;

    const { rows } = await db.query(
      `SELECT storage_path, mime, project_id FROM files WHERE id = $1 LIMIT 1`,
      [fileId]
    );

    if (!rows[0]) return apiError(reply, "STOR_004");

    // If accessed via subdomain, enforce project ownership
    if (resolvedProjectId && rows[0].project_id !== resolvedProjectId) {
      return apiError(reply, "STOR_004");
    }

    const filePath = rows[0].storage_path;
    if (!fs.existsSync(filePath)) return apiError(reply, "STOR_004");

    const mime = rows[0].mime || "application/octet-stream";
    const stat = fs.statSync(filePath);

    reply.header("Content-Type", mime);
    reply.header("Content-Length", stat.size);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");

    return reply.send(fs.createReadStream(filePath));
  });
};

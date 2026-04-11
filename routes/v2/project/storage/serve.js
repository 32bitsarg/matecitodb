const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const {
  db,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

function signUrl(fileId, expiresAt) {
  const secret = process.env.JWT_SECRET;
  const data   = `${fileId}:${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

module.exports = async function (fastify) {
  // GET /storage/serve/:fileId?sig=xxx&exp=1234567890
  projectRoute(fastify, "GET", "/storage/serve/:fileId", {}, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { fileId } = req.params;
    const { sig, exp } = req.query;

    if (!sig || !exp) return reply.code(401).send({ error: "Missing signature", code: "AUTH_001" });

    const expiresAt = parseInt(exp, 10);
    if (isNaN(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
      return reply.code(401).send({ error: "Signed URL has expired", code: "AUTH_002" });
    }

    const expected = signUrl(fileId, expiresAt);
    const sigBuf   = Buffer.from(sig,      "hex");
    const expBuf   = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return reply.code(401).send({ error: "Invalid signature", code: "AUTH_001" });
    }

    const { rows } = await db.query(
      `SELECT id, storage_path, mime, project_id FROM files WHERE id = $1 AND project_id = $2 LIMIT 1`,
      [fileId, projectId]
    );
    if (!rows[0]) return apiError(reply, "STOR_004");

    const filePath = rows[0].storage_path;
    if (!fs.existsSync(filePath)) return apiError(reply, "STOR_004");

    const mime = rows[0].mime || "application/octet-stream";
    const stat = fs.statSync(filePath);

    reply.header("Content-Type", mime);
    reply.header("Content-Length", stat.size);
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("X-Content-Type-Options", "nosniff");

    return reply.send(fs.createReadStream(filePath));
  });
};

const fs    = require("fs");
const path  = require("path");
const sharp = require("sharp");
const { db, requireProjectOrPlatformAuth, projectRoute } = require("../../../lib/matecito");

const STORAGE_BASE = process.env.STORAGE_PATH || path.join(__dirname, "../../../../storage");
const STORAGE_URL  = process.env.STORAGE_URL  || "http://localhost:3000/storage/files";

async function checkStorageQuota(projectId, additionalBytes) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(f.size), 0)             AS used_bytes,
       COALESCE(p.storage_quota_mb, 250)    AS quota_mb
     FROM projects p
     LEFT JOIN files f ON f.project_id = p.id
     WHERE p.id = $1
     GROUP BY p.storage_quota_mb`,
    [projectId]
  );
  if (!rows[0]) return { ok: false, reason: "Project not found" };

  const usedBytes  = Number(rows[0].used_bytes);
  const quotaBytes = Number(rows[0].quota_mb) * 1024 * 1024;

  if (usedBytes + additionalBytes > quotaBytes) {
    const usedMb  = (usedBytes / 1024 / 1024).toFixed(1);
    const quotaMb = rows[0].quota_mb;
    return { ok: false, reason: `Storage quota exceeded (${usedMb} MB / ${quotaMb} MB)` };
  }
  return { ok: true };
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!projectId) {
      return reply.code(400).send({ error: "Project not found" });
    }

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "File required" });
    }
    if (!file.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are supported" });
    }

    const buffer = await file.toBuffer();

    // Verificar cuota antes de procesar (estimación: buffer size como worst case)
    const quota = await checkStorageQuota(projectId, buffer.length);
    if (!quota.ok) {
      return reply.code(413).send({ error: quota.reason });
    }

    const folder = path.join(STORAGE_BASE, projectId);
    fs.mkdirSync(folder, { recursive: true });

    const filename    = `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
    const storagePath = path.join(folder, filename);

    const image    = sharp(buffer).rotate().resize({ width: 1600, withoutEnlargement: true });
    const metadata = await image.metadata();

    try {
      await image.webp({ quality: 82 }).toFile(storagePath);
    } catch (err) {
      try { fs.unlinkSync(storagePath); } catch {}
      throw err;
    }

    const stat      = fs.statSync(storagePath);
    const publicUrl = `${STORAGE_URL}/${projectId}/${filename}`;

    const result = await db.query(
      `INSERT INTO files (project_id, storage_path, url, mime, size, width, height, variant, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'webp', NOW())
       RETURNING id, project_id, url, mime, size, width, height, variant, created_at`,
      [projectId, storagePath, publicUrl, "image/webp", stat.size, metadata.width || null, metadata.height || null]
    );

    return reply.code(201).send({ file: result.rows[0] });
  };

  projectRoute(fastify, "POST", "/storage/upload", {
    preHandler: requireProjectOrPlatformAuth,
  }, handler);
};

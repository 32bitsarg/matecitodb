const fs   = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  db,
  requireProjectOrPlatformAuth,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const STORAGE_BASE = process.env.STORAGE_PATH || path.join(__dirname, "../../../../../storage");
const DOMAIN       = process.env.DOMAIN       || "matecito.dev";

async function checkStorageQuota(projectId, additionalBytes) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(f.size), 0) AS used_bytes, COALESCE(p.storage_quota_mb, 250) AS quota_mb
     FROM projects p LEFT JOIN files f ON f.project_id = p.id
     WHERE p.id = $1 GROUP BY p.storage_quota_mb`,
    [projectId]
  );
  if (!rows[0]) return { ok: false, reason: "Project not found" };
  const usedBytes  = Number(rows[0].used_bytes);
  const quotaBytes = Number(rows[0].quota_mb) * 1024 * 1024;
  if (usedBytes + additionalBytes > quotaBytes) {
    return { ok: false, reason: `Storage quota exceeded (${(usedBytes / 1024 / 1024).toFixed(1)} MB / ${rows[0].quota_mb} MB)` };
  }
  return { ok: true };
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!projectId) return apiError(reply, "GEN_003", "Project not found");

    const { url } = req.body ?? {};
    if (!url || typeof url !== "string") return reply.code(400).send({ error: "url is required", code: "GEN_002" });
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return reply.code(400).send({ error: "url must start with http:// or https://", code: "GEN_002" });
    }

    let fetchRes;
    try { fetchRes = await fetch(url); }
    catch (err) { return reply.code(400).send({ error: `Failed to fetch URL: ${err.message}`, code: "GEN_004" }); }

    if (!fetchRes.ok) return reply.code(400).send({ error: `Remote URL returned status ${fetchRes.status}`, code: "GEN_004" });

    const contentType = fetchRes.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are supported", code: "GEN_002" });
    }

    const buffer = Buffer.from(await fetchRes.arrayBuffer());
    const quota  = await checkStorageQuota(projectId, buffer.length);
    if (!quota.ok) return reply.code(413).send({ error: quota.reason, code: "GEN_002" });

    const folder       = path.join(STORAGE_BASE, projectId);
    fs.mkdirSync(folder, { recursive: true });

    const outFilename  = `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
    const storagePath  = path.join(folder, outFilename);

    const image    = sharp(buffer).rotate().resize({ width: 1600, withoutEnlargement: true });
    const metadata = await image.metadata();
    await image.webp({ quality: 82 }).toFile(storagePath);

    const stat = fs.statSync(storagePath);

    const { rows } = await db.query(
      `INSERT INTO files (project_id, storage_path, url, mime, size, width, height, variant, created_at)
       VALUES ($1, $2, '', $3, $4, $5, $6, 'webp', NOW())
       RETURNING id, project_id, mime, size, width, height, variant, created_at`,
      [projectId, storagePath, "image/webp", stat.size, metadata.width || null, metadata.height || null]
    );

    const fileId = rows[0].id;

    let subdomain = project?.subdomain;
    if (!subdomain) {
      const { rows: pRows } = await db.query(
        `SELECT subdomain FROM projects WHERE id = $1 LIMIT 1`, [projectId]
      );
      subdomain = pRows[0]?.subdomain;
    }

    const publicUrl = subdomain
      ? `https://${subdomain}.${DOMAIN}/storage/files/${fileId}`
      : `https://api.${DOMAIN}/api/v2/project/storage/files/${fileId}`;

    await db.query(`UPDATE files SET url = $1 WHERE id = $2`, [publicUrl, fileId]);

    return reply.code(201).send({ file: { ...rows[0], url: publicUrl } });
  };

  projectRoute(fastify, "POST", "/storage/upload-url", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: { url: { type: "string", format: "uri" } },
      },
    },
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, handler);
};

const crypto = require("crypto");
const {
  db,
  requireProjectOrPlatformAuth,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const DEFAULT_TTL = 3600; // 1 hour
const MAX_TTL     = 7 * 24 * 3600; // 7 days

function signUrl(fileId, expiresAt) {
  const secret = process.env.JWT_SECRET;
  const data   = `${fileId}:${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

module.exports = async function (fastify) {
  // POST /storage/presign  { file_id, expires_in? }
  projectRoute(fastify, "POST", "/storage/presign", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["file_id"],
        additionalProperties: false,
        properties: {
          file_id:    { type: "string" },
          expires_in: { type: "integer", minimum: 60, maximum: MAX_TTL, default: DEFAULT_TTL },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { file_id, expires_in = DEFAULT_TTL } = req.body;

    const { rows } = await db.query(
      `SELECT id, url, project_id FROM files WHERE id = $1 AND project_id = $2 LIMIT 1`,
      [file_id, projectId]
    );
    if (!rows[0]) return apiError(reply, "STOR_004");

    const expiresAt  = Math.floor(Date.now() / 1000) + expires_in;
    const sig        = signUrl(file_id, expiresAt);
    const apiBase    = process.env.API_BASE_URL || `https://${req.headers.host}`;
    const signedUrl  = `${apiBase}/api/v2/project/${projectId}/storage/serve/${file_id}?sig=${sig}&exp=${expiresAt}`;

    return { url: signedUrl, expires_at: new Date(expiresAt * 1000).toISOString(), expires_in };
  });
};

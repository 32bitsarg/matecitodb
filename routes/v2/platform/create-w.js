const { db, requirePlatformAuth } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

module.exports = async function (fastify) {
  fastify.post("/create-w", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name", "slug"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2, maxLength: 128 },
          slug: { type: "string", minLength: 3, maxLength: 60 },
        },
      },
    },
  }, async (req, reply) => {
    const userId = req.user.id;
    const name   = String(req.body.name || "").trim();
    const slug   = String(req.body.slug || "").trim().toLowerCase();

    if (!SLUG_RE.test(slug)) {
      return apiError(reply, "GEN_001", "Slug must be 3-60 chars, lowercase letters, numbers and hyphens only");
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const existing = await client.query(`SELECT 1 FROM workspaces WHERE slug = $1 LIMIT 1`, [slug]);
      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        return apiError(reply, "GEN_004", "Slug already taken");
      }

      const workspaceRes = await client.query(
        `INSERT INTO workspaces (name, slug, owner_id) VALUES ($1, $2, $3)
         RETURNING id, name, slug, owner_id, created_at`,
        [name, slug, userId]
      );
      const workspace = workspaceRes.rows[0];

      await client.query(
        `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'owner')`,
        [userId, workspace.id]
      );

      await client.query("COMMIT");
      return reply.code(201).send({ workspace });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ step: "create_workspace", error: err.message });
      return apiError(reply, "GEN_002");
    } finally {
      client.release();
    }
  });
};

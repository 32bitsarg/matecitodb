const { db, requirePlatformAuth } = require("../../lib/matecito");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

module.exports = async function (fastify) {
  fastify.post("/create-w", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId = req.user.id;
    const name   = String(req.body?.name || "").trim();
    const slug   = String(req.body?.slug || "").trim().toLowerCase();

    if (!name || name.length < 2) {
      return reply.code(400).send({ error: "Workspace name is required (min 2 chars)" });
    }
    if (!slug || !SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: "Slug must be 3-60 chars, lowercase letters, numbers and hyphens only" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Verificar slug único antes de insertar para dar un 409 limpio
      const existing = await client.query(
        `SELECT 1 FROM workspaces WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Slug already taken" });
      }

      const workspaceRes = await client.query(
        `INSERT INTO workspaces (name, slug, owner_id)
         VALUES ($1, $2, $3)
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
      fastify.log.error(err);
      return reply.code(500).send({ error: "Could not create workspace" });
    } finally {
      client.release();
    }
  });
};

const bcrypt = require("bcryptjs");
const { db, generateToken, createPlatformRefreshToken } = require("../../../lib/matecito");

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

module.exports = async function (fastify) {
  fastify.post("/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const username   = String(req.body?.username   || "").trim();
    const name       = String(req.body?.name       || "").trim();
    const email      = String(req.body?.email      || "").trim().toLowerCase();
    const password   = String(req.body?.password   || "");
    const avatarSeed = String(req.body?.avatarSeed || generateToken(8)).trim();

    if (!username || !name || !email || password.length < 6) {
      return reply.code(400).send({
        error: "username, name, email and password(6+) are required",
      });
    }

    const existing = await db.query(
      `SELECT 1 FROM users WHERE email = $1 OR username = $2 LIMIT 1`,
      [email, username]
    );
    if (existing.rows[0]) {
      return reply.code(409).send({ error: "User already exists" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const hash = await bcrypt.hash(password, 10);

      const userRes = await client.query(
        `INSERT INTO users (username, name, email, password_hash, avatar_seed, avatar_url)
         VALUES ($1, $2, $3, $4, $5, NULL)
         RETURNING id, username, name, email, avatar_seed, avatar_url, created_at`,
        [username, name, email, hash, avatarSeed]
      );
      const user = userRes.rows[0];

      // Slug único para el workspace
      const baseSlug  = slugify(`${name}s workspace`);
      const slugCheck = await client.query(
        `SELECT slug FROM workspaces WHERE slug LIKE $1 ORDER BY slug`,
        [`${baseSlug}%`]
      );
      const taken = new Set(slugCheck.rows.map((r) => r.slug));
      const slug  = taken.has(baseSlug) ? `${baseSlug}-${generateToken(3)}` : baseSlug;

      const workspaceRes = await client.query(
        `INSERT INTO workspaces (name, slug, owner_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, slug, owner_id, created_at`,
        [`${name}'s workspace`, slug, user.id]
      );

      await client.query(
        `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'owner')`,
        [user.id, workspaceRes.rows[0].id]
      );

      await client.query("COMMIT");

      const [access_token, refresh_token] = await Promise.all([
        fastify.jwt.sign(
          { sub: user.id, email: user.email, username: user.username, name: user.name, kind: "platform" },
          { expiresIn: "1d" }
        ),
        createPlatformRefreshToken(user.id),
      ]);

      return reply.code(201).send({
        access_token,
        refresh_token,
        expires_in: 86400,
        user,
        workspace: workspaceRes.rows[0],
      });
    } catch (err) {
      await client.query("ROLLBACK");
      fastify.log.error(err);
      return reply.code(500).send({ error: "Could not register user" });
    } finally {
      client.release();
    }
  });
};

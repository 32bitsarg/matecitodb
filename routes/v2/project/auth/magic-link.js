const {
  db,
  quoteIdent,
  projectRoute,
  getProjectByAnonKey,
  createProjectRefreshToken,
  logAuthEvent,
} = require("../../../../lib/v2/auth");
const { hashToken, createOAuthCode } = require("../../../../lib/v2/auth");
const { generateToken }  = require("../../../../lib/v2/auth");
const { apiError }       = require("../../../../lib/v2/errors");
const { enqueueEmail }   = require("../../../../lib/v2/queue");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const crypto             = require("crypto");

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function resolveProject(req, reply) {
  if (req.resolvedProject) return req.resolvedProject;
  const projectId = req.params?.projectId;
  const anonKey   = String(req.headers["x-matecito-key"] || "").trim();
  if (!projectId || !anonKey) {
    reply.code(400).send({ error: "projectId and x-matecito-key required", code: "PROJ_003" });
    return null;
  }
  const project = await getProjectByAnonKey(projectId, anonKey);
  if (!project) { reply.code(403).send({ error: "Invalid project key", code: "PROJ_005" }); return null; }
  return project;
}

async function ensureMagicLinkTable(s) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._magic_links (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    TEXT NOT NULL,
      token      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS _magic_links_token_idx ON ${s}._magic_links(token)
  `).catch(() => {});
}

module.exports = async function (fastify) {
  // POST /auth/magic-link  { email, redirect_url? }
  projectRoute(fastify, "POST", "/auth/magic-link", {
    config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
    schema: {
      body: {
        type: "object",
        required: ["email"],
        additionalProperties: false,
        properties: {
          email:        { type: "string", format: "email", maxLength: 254 },
          redirect_url: { type: "string", format: "uri", maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const project = await resolveProject(req, reply);
    if (!project) return;

    const email       = String(req.body.email || "").trim().toLowerCase();
    const redirectUrl = String(req.body.redirect_url || "").trim();
    const s           = quoteIdent(project.schema_name);

    await ensureV2Tables(project.schema_name).catch(() => {});
    await ensureMagicLinkTable(s).catch(() => {});

    // Look up or create user
    let user;
    const existing = await db.query(
      `SELECT id, email, username, name, avatar_url, email_verified FROM ${s}._auth_users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (existing.rows[0]) {
      user = existing.rows[0];
    } else {
      // Auto-create user without password
      const { rows } = await db.query(
        `INSERT INTO ${s}._auth_users (email, password_hash, email_verified)
         VALUES ($1, '', TRUE) RETURNING id, email, username, name, avatar_url, email_verified`,
        [email]
      );
      user = rows[0];
    }

    // Create hashed token
    const raw     = crypto.randomBytes(32).toString("hex");
    const hashed  = hashToken(raw);
    const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS);

    // Invalidate previous unused tokens for this user
    await db.query(
      `UPDATE ${s}._magic_links SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );
    await db.query(
      `INSERT INTO ${s}._magic_links (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, hashed, expires]
    );

    const projectRow  = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [project.id]);
    const projectName = projectRow.rows[0]?.name ?? "App";

    const apiBase   = process.env.API_BASE_URL || `https://${req.headers.host}`;
    const verifyUrl = redirectUrl
      ? `${redirectUrl}?magic_token=${raw}`
      : `${apiBase}/api/v2/project/${project.id}/auth/magic-link/verify?token=${raw}`;

    enqueueEmail(project.schema_name, projectName, {
      to:              email,
      templateName:    "magic_link",
      vars:            { "user.email": email, "magic_url": verifyUrl, "expires_minutes": "15" },
      fallbackSubject: `Tu enlace de acceso — ${projectName}`,
      fallbackHtml:    `<p>Accedé a tu cuenta haciendo click en el siguiente enlace (válido 15 minutos):<br><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });

    // Dev mode: return raw token
    if (process.env.NODE_ENV !== "production") {
      return { message: "Magic link sent", _dev_url: verifyUrl };
    }
    return { message: "If that email is registered, a magic link has been sent." };
  });

  // GET /auth/magic-link/verify?token=xxx
  projectRoute(fastify, "GET", "/auth/magic-link/verify", {
    config: { rateLimit: { max: 20, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const project = await resolveProject(req, reply);
    if (!project) return;

    const raw = String(req.query?.token || "").trim();
    if (!raw) return reply.code(400).send({ error: "token is required", code: "GEN_002" });

    const s      = quoteIdent(project.schema_name);
    const hashed = hashToken(raw);

    await ensureMagicLinkTable(s).catch(() => {});

    const { rows } = await db.query(
      `SELECT id, user_id, expires_at, used_at FROM ${s}._magic_links WHERE token = $1 LIMIT 1`,
      [hashed]
    );

    const link = rows[0];
    if (!link || link.used_at || new Date(link.expires_at) < new Date()) {
      return reply.code(400).send({ error: "Invalid or expired magic link", code: "AUTH_008" });
    }

    // Mark as used
    await db.query(`UPDATE ${s}._magic_links SET used_at = NOW() WHERE id = $1`, [link.id]);
    // Mark email as verified
    await db.query(`UPDATE ${s}._auth_users SET email_verified = TRUE WHERE id = $1`, [link.user_id]);

    const { rows: userRows } = await db.query(
      `SELECT id, email, username, name, avatar_url, email_verified FROM ${s}._auth_users WHERE id = $1 LIMIT 1`,
      [link.user_id]
    );
    const user = userRows[0];
    if (!user) return reply.code(404).send({ error: "User not found", code: "GEN_003" });

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, pid: project.id, kind: "project", email: user.email, username: user.username, name: user.name },
        { expiresIn: "1d" }
      ),
      createProjectRefreshToken(project.schema_name, user.id),
    ]);

    logAuthEvent(project.schema_name, { event: "magic_link_login", userId: user.id, ip: req.ip, status: 200 });

    // Use one-time code exchange (same pattern as OAuth)
    const oauthCode  = createOAuthCode({ access_token, refresh_token, user, projectId: project.id });
    const redirectTo = req.query.redirect_url;

    if (redirectTo) {
      const url = new URL(redirectTo);
      url.searchParams.set("code", oauthCode);
      return reply.redirect(url.toString());
    }

    return { access_token, refresh_token, expires_in: 86400, user };
  });
};

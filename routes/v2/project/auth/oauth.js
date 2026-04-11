const {
  db,
  quoteIdent,
  projectRoute,
  createProjectRefreshToken,
  logAuthEvent,
} = require("../../../../lib/v2/auth");
const { createOAuthCode, consumeOAuthCode } = require("../../../../lib/v2/oauth-codes");
const { createOAuthState, consumeOAuthState } = require("../../../../lib/oauth-state");
const { apiError } = require("../../../../lib/v2/errors");

const OAUTH_CONFIG = {
  google: {
    authUrl:  "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userUrl:  "https://www.googleapis.com/oauth2/v2/userinfo",
    scope:    "openid email profile",
  },
  github: {
    authUrl:  "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl:  "https://api.github.com/user",
    scope:    "read:user user:email",
  },
};

async function getProvider(schemaName, provider) {
  const s = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT * FROM ${s}._oauth_providers WHERE provider = $1 AND enabled = true LIMIT 1`,
    [provider]
  );
  return rows[0] ?? null;
}

async function exchangeCode(provider, code, redirectUri, clientId, clientSecret) {
  const cfg    = OAUTH_CONFIG[provider];
  const params = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    "authorization_code",
  });
  const res = await fetch(cfg.tokenUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body:    params.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

async function getUserInfo(provider, accessToken) {
  const cfg = OAUTH_CONFIG[provider];
  const res = await fetch(cfg.userUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "matecito-baas/2.0" },
  });
  if (!res.ok) throw new Error(`User info fetch failed: ${res.status}`);
  return res.json();
}

async function getGitHubEmail(accessToken) {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "matecito-baas/2.0" },
  });
  if (!res.ok) return null;
  const emails = await res.json();
  const primary = emails.find(e => e.primary && e.verified);
  return primary?.email ?? emails[0]?.email ?? null;
}

module.exports = async function (fastify) {
  // GET /auth/oauth/:provider?redirect_uri=https://...
  projectRoute(fastify, "GET", "/auth/oauth/:provider", {}, async (req, reply) => {
    const { provider }   = req.params;
    const { redirect_uri } = req.query;
    const project        = req.resolvedProject;
    const projectId      = project?.id ?? req.params?.projectId;

    if (!OAUTH_CONFIG[provider]) return reply.code(400).send({ error: `Unsupported provider: ${provider}`, code: "GEN_002" });
    if (!redirect_uri)           return reply.code(400).send({ error: "redirect_uri is required", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const providerRow = await getProvider(schemaName, provider);
    if (!providerRow) return reply.code(404).send({ error: `OAuth provider '${provider}' not configured`, code: "GEN_003" });

    const state = createOAuthState({ projectId, schemaName, redirectUri: redirect_uri, provider });

    // v2: callback always uses /api/v2/... path
    const apiBase     = process.env.API_BASE_URL || `https://${req.headers.host}`;
    const callbackUrl = `${apiBase}/api/v2/project/${projectId}/auth/oauth/${provider}/callback`;

    const cfg    = OAUTH_CONFIG[provider];
    const params = new URLSearchParams({
      client_id:     providerRow.client_id,
      redirect_uri:  callbackUrl,
      scope:         cfg.scope,
      state,
      response_type: "code",
    });

    return reply.redirect(`${cfg.authUrl}?${params.toString()}`);
  });

  // GET /auth/oauth/:provider/callback?code=...&state=...
  // v2 SECURITY FIX: does NOT put tokens in URL. Generates a one-time code instead.
  projectRoute(fastify, "GET", "/auth/oauth/:provider/callback", {}, async (req, reply) => {
    const { provider } = req.params;
    const { code, state, error } = req.query;

    if (error) return reply.code(400).send({ error, code: "AUTH_010" });
    if (!code || !state) return reply.code(400).send({ error: "Missing code or state", code: "GEN_002" });

    const stateData = consumeOAuthState(state);
    if (!stateData) return reply.code(400).send({ error: "Invalid or expired state", code: "AUTH_010" });

    const { projectId, schemaName, redirectUri } = stateData;

    const providerRow = await getProvider(schemaName, provider);
    if (!providerRow) return reply.code(404).send({ error: "Provider not found", code: "GEN_003" });

    const apiBase     = process.env.API_BASE_URL || `https://${req.headers.host}`;
    const callbackUrl = `${apiBase}/api/v2/project/${projectId}/auth/oauth/${provider}/callback`;

    let tokens, userInfo, email, providerUserId, username, avatarUrl;

    try {
      tokens   = await exchangeCode(provider, code, callbackUrl, providerRow.client_id, providerRow.client_secret);
      userInfo = await getUserInfo(provider, tokens.access_token);

      if (provider === "google") {
        providerUserId = userInfo.id;
        email          = userInfo.email;
        username       = userInfo.name ?? email;
        avatarUrl      = userInfo.picture ?? null;
      } else if (provider === "github") {
        providerUserId = String(userInfo.id);
        email          = userInfo.email ?? await getGitHubEmail(tokens.access_token);
        username       = userInfo.login;
        avatarUrl      = userInfo.avatar_url ?? null;
      }
    } catch (err) {
      return reply.code(502).send({ error: "OAuth provider error: " + err.message, code: "GEN_005" });
    }

    if (!email) return reply.code(400).send({ error: "Could not retrieve email from provider", code: "AUTH_010" });

    const s = quoteIdent(schemaName);

    const { rows } = await db.query(
      `INSERT INTO ${s}._auth_users (email, username, password_hash, oauth_provider, oauth_id, avatar_url, email_verified)
       VALUES ($1, $2, '', $3, $4, $5, TRUE)
       ON CONFLICT (email) DO UPDATE
         SET oauth_provider  = EXCLUDED.oauth_provider,
             oauth_id        = EXCLUDED.oauth_id,
             avatar_url      = COALESCE(EXCLUDED.avatar_url, ${s}._auth_users.avatar_url),
             email_verified  = TRUE,
             updated_at      = NOW()
       RETURNING id, email, username, name, avatar_url, email_verified`,
      [email, username, provider, providerUserId, avatarUrl]
    );

    const user = rows[0];

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, pid: projectId, kind: "project", email: user.email, username: user.username, name: user.name },
        { expiresIn: "1d" }
      ),
      createProjectRefreshToken(schemaName, user.id),
    ]);

    logAuthEvent(schemaName, { event: "oauth_login", userId: user.id, ip: req.ip, status: 200 });

    // v2: store tokens in short-lived code, redirect with code only (not tokens)
    const oauthCode = createOAuthCode({ access_token, refresh_token, user, projectId });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", oauthCode);

    return reply.redirect(redirectUrl.toString());
  });

  // POST /auth/oauth/exchange  { code }
  // v2 NEW: exchange one-time OAuth code for tokens
  projectRoute(fastify, "POST", "/auth/oauth/exchange", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      body: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: {
          code: { type: "string", minLength: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { code } = req.body;
    const data = consumeOAuthCode(code);
    if (!data) return reply.code(400).send({ error: "Invalid or expired OAuth code", code: "AUTH_010" });

    const { access_token, refresh_token, user } = data;
    return { access_token, refresh_token, expires_in: 86400, user };
  });
};

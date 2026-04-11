const crypto = require("crypto");
const {
  db,
  quoteIdent,
  projectRoute,
  requireProjectAuth,
  logAuthEvent,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

// Lazy-load otpauth to avoid crash if not installed yet
function getOTPAuth() {
  try { return require("otpauth"); } catch {
    throw new Error("otpauth package is required for 2FA. Run: npm install otpauth");
  }
}

const BACKUP_CODE_COUNT = 8;

function generateBackupCodes() {
  return Array.from({ length: BACKUP_CODE_COUNT }, () =>
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

function hashBackupCode(code) {
  return crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
}

async function ensureTotpColumns(s) {
  await db.query(`
    ALTER TABLE ${s}._auth_users
      ADD COLUMN IF NOT EXISTS totp_secret      TEXT,
      ADD COLUMN IF NOT EXISTS totp_enabled     BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[]
  `).catch(() => {});
}

// Short-lived TOTP sessions (5 min) — user has verified password but not TOTP yet
const _totpSessions = new Map(); // token → { userId, schemaName, exp }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _totpSessions) {
    if (v.exp < now) _totpSessions.delete(k);
  }
}, 60_000).unref();

function createTotpSession(userId, schemaName) {
  const token = crypto.randomBytes(24).toString("hex");
  _totpSessions.set(token, { userId, schemaName, exp: Date.now() + 5 * 60_000 });
  return token;
}

function consumeTotpSession(token) {
  const session = _totpSessions.get(token);
  if (!session || session.exp < Date.now()) { _totpSessions.delete(token); return null; }
  _totpSessions.delete(token);
  return session;
}

async function resolveProject(req) {
  const project   = req.resolvedProject;
  const projectId = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { project, projectId, schemaName };
}

module.exports = async function (fastify) {
  // POST /auth/totp/setup  → returns secret + QR URI (not yet active)
  projectRoute(fastify, "POST", "/auth/totp/setup", {
    preHandler: requireProjectAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { projectId, schemaName } = await resolveProject(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const OTPAuth = getOTPAuth();
    const s       = quoteIdent(schemaName);
    await ensureTotpColumns(s);

    const { rows } = await db.query(
      `SELECT id, email, totp_enabled FROM ${s}._auth_users WHERE id = $1 LIMIT 1`,
      [req.projectUser.id]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "User not found");
    if (rows[0].totp_enabled) {
      return reply.code(400).send({ error: "2FA is already enabled. Disable it first.", code: "GEN_002" });
    }

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp   = new OTPAuth.TOTP({
      issuer:    "Matebase",
      label:     rows[0].email ?? req.projectUser.id,
      algorithm: "SHA1",
      digits:    6,
      period:    30,
      secret,
    });

    // Save secret (not yet enabled)
    await db.query(
      `UPDATE ${s}._auth_users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2`,
      [secret.base32, req.projectUser.id]
    );

    return {
      secret:  secret.base32,
      qr_uri:  totp.toString(),
      message: "Scan this QR code with your authenticator app, then confirm with POST /auth/totp/confirm",
    };
  });

  // POST /auth/totp/confirm  { code }  → activates 2FA + returns backup codes
  projectRoute(fastify, "POST", "/auth/totp/confirm", {
    preHandler: requireProjectAuth,
    schema: {
      body: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: { code: { type: "string", minLength: 6, maxLength: 6 } },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { schemaName } = await resolveProject(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const OTPAuth = getOTPAuth();
    const s       = quoteIdent(schemaName);
    await ensureTotpColumns(s);

    const { rows } = await db.query(
      `SELECT id, totp_secret, totp_enabled FROM ${s}._auth_users WHERE id = $1 LIMIT 1`,
      [req.projectUser.id]
    );
    if (!rows[0]?.totp_secret) {
      return reply.code(400).send({ error: "Call /auth/totp/setup first", code: "GEN_002" });
    }

    const totp  = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(rows[0].totp_secret), digits: 6, period: 30 });
    const delta = totp.validate({ token: req.body.code, window: 1 });
    if (delta === null) return reply.code(400).send({ error: "Invalid TOTP code", code: "AUTH_003" });

    const rawBackupCodes    = generateBackupCodes();
    const hashedBackupCodes = rawBackupCodes.map(hashBackupCode);

    await db.query(
      `UPDATE ${s}._auth_users SET totp_enabled = TRUE, totp_backup_codes = $1 WHERE id = $2`,
      [hashedBackupCodes, req.projectUser.id]
    );

    return {
      ok:           true,
      backup_codes: rawBackupCodes,
      message:      "2FA enabled. Save your backup codes — they won't be shown again.",
    };
  });

  // POST /auth/totp/disable  { code }
  projectRoute(fastify, "POST", "/auth/totp/disable", {
    preHandler: requireProjectAuth,
    schema: {
      body: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: { code: { type: "string", minLength: 6, maxLength: 8 } },
      },
    },
    config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const { schemaName } = await resolveProject(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const OTPAuth = getOTPAuth();
    const s       = quoteIdent(schemaName);
    await ensureTotpColumns(s);

    const { rows } = await db.query(
      `SELECT id, totp_secret, totp_enabled, totp_backup_codes FROM ${s}._auth_users WHERE id = $1 LIMIT 1`,
      [req.projectUser.id]
    );
    if (!rows[0]?.totp_enabled) {
      return reply.code(400).send({ error: "2FA is not enabled", code: "GEN_002" });
    }

    const { code } = req.body;
    let valid = false;

    // Check TOTP code
    const totp  = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(rows[0].totp_secret), digits: 6, period: 30 });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta !== null) valid = true;

    // Or backup code
    if (!valid && code.length === 8) {
      const hashed = hashBackupCode(code);
      if ((rows[0].totp_backup_codes ?? []).includes(hashed)) valid = true;
    }

    if (!valid) return reply.code(400).send({ error: "Invalid code", code: "AUTH_003" });

    await db.query(
      `UPDATE ${s}._auth_users SET totp_secret = NULL, totp_enabled = FALSE, totp_backup_codes = NULL WHERE id = $1`,
      [req.projectUser.id]
    );

    logAuthEvent(schemaName, { event: "totp_disabled", userId: req.projectUser.id, ip: req.ip, status: 200 });

    return { ok: true, message: "2FA disabled" };
  });

  // POST /auth/totp/verify  { totp_session, code }
  // Called after login when requires_totp === true
  projectRoute(fastify, "POST", "/auth/totp/verify", {
    schema: {
      body: {
        type: "object",
        required: ["totp_session", "code"],
        additionalProperties: false,
        properties: {
          totp_session: { type: "string", minLength: 10 },
          code:         { type: "string", minLength: 6, maxLength: 8 },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const { totp_session, code } = req.body;

    const session = consumeTotpSession(totp_session);
    if (!session) return reply.code(400).send({ error: "Invalid or expired TOTP session", code: "AUTH_002" });

    const { projectId, schemaName } = await resolveProject(req);
    const s       = quoteIdent(session.schemaName);
    const OTPAuth = getOTPAuth();

    const { rows } = await db.query(
      `SELECT id, email, username, name, avatar_url, totp_secret, totp_backup_codes FROM ${s}._auth_users WHERE id = $1 LIMIT 1`,
      [session.userId]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "User not found");

    const user  = rows[0];
    let valid   = false;

    const totp  = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totp_secret), digits: 6, period: 30 });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta !== null) valid = true;

    if (!valid && code.length === 8) {
      const hashed    = hashBackupCode(code);
      const backupIdx = (user.totp_backup_codes ?? []).indexOf(hashed);
      if (backupIdx !== -1) {
        valid = true;
        // Consume the backup code
        const remaining = user.totp_backup_codes.filter((_, i) => i !== backupIdx);
        await db.query(
          `UPDATE ${s}._auth_users SET totp_backup_codes = $1 WHERE id = $2`,
          [remaining, user.id]
        );
      }
    }

    if (!valid) return reply.code(400).send({ error: "Invalid TOTP code", code: "AUTH_003" });

    const { createProjectRefreshToken } = require("../../../../lib/v2/auth");
    const pid = projectId ?? session.schemaName.replace("proj_", "");

    let roles = [];
    try {
      const rolesRes = await db.query(`SELECT role FROM ${s}._user_roles WHERE user_id = $1`, [user.id]);
      roles = rolesRes.rows.map(r => r.role);
    } catch {}

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, pid, kind: "project", email: user.email, username: user.username, name: user.name, roles },
        { expiresIn: "1d" }
      ),
      createProjectRefreshToken(session.schemaName, user.id),
    ]);

    logAuthEvent(session.schemaName, { event: "totp_verified", userId: user.id, ip: req.ip, status: 200 });

    delete user.totp_secret;
    delete user.totp_backup_codes;

    return { access_token, refresh_token, expires_in: 86400, user };
  });

  // Export createTotpSession so login can use it
  fastify.decorate("createTotpSession", createTotpSession);
};

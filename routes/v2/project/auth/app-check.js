// ─── App Check (J1) — Proof-of-work anti-bot ───────────────────────────────
//
// GET  /auth/app-check/challenge  → obtener challenge
// POST /auth/app-check/verify     → resolver challenge y obtener token
//
// El cliente debe resolver un SHA-256 proof-of-work antes de acceder
// a endpoints públicos protegidos.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const crypto             = require("crypto");

// Generar app_token corto (JWT-like)
function generateAppToken(projectId, ip, expiresAt) {
  const payload = `${projectId}:${ip}:${expiresAt}`;
  const sig = crypto.createHmac("sha256", process.env.JWT_SECRET || "fallback").update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function verifyAppToken(token, projectId) {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split(":");
    if (parts.length !== 4) return null;
    const [pProjectId, ip, expiresAt, sig] = parts;
    const expectedSig = crypto.createHmac("sha256", process.env.JWT_SECRET || "fallback")
      .update(`${pProjectId}:${ip}:${expiresAt}`).digest("hex");
    if (sig !== expectedSig) return null;
    if (Date.now() > parseInt(expiresAt, 10)) return null;
    return { projectId: pProjectId, ip, expiresAt: parseInt(expiresAt, 10) };
  } catch { return null; }
}

const CHALLENGE_TTL = 60_000; // 60s
const _challenges = new Map(); // challenge -> { expiresAt, difficulty, ip }

module.exports = async function (fastify) {
  // ── GET /auth/app-check/challenge ──────────────────────────────────────
  fastify.get("/auth/app-check/challenge", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!projectId) return apiError(reply, "GEN_003", "Project not found");

    const challenge = crypto.randomBytes(16).toString("hex");
    const difficulty = 4; // number of leading zeros required
    const expiresAt = Date.now() + CHALLENGE_TTL;

    _challenges.set(challenge, { expiresAt, difficulty, ip: req.ip });

    // Cleanup expired challenges periodically
    if (_challenges.size > 10000) {
      const now = Date.now();
      for (const [k, v] of _challenges) {
        if (v.expiresAt < now) _challenges.delete(k);
      }
    }

    return {
      challenge,
      difficulty,
      expires_in: 60,
      hint: `Find nonce such that SHA256(challenge + nonce) has ${difficulty} leading zeros`,
    };
  });

  // ── POST /auth/app-check/verify ────────────────────────────────────────
  fastify.post("/auth/app-check/verify", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["challenge", "nonce"],
        properties: {
          challenge: { type: "string" },
          nonce:     { type: "string" },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { challenge, nonce } = req.body;

    const challengeData = _challenges.get(challenge);
    if (!challengeData) {
      return reply.code(400).send({ error: "Invalid or expired challenge", code: "GEN_002" });
    }

    if (challengeData.expiresAt < Date.now()) {
      _challenges.delete(challenge);
      return reply.code(400).send({ error: "Challenge expired", code: "GEN_002" });
    }

    // Verify proof-of-work
    const hash = crypto.createHash("sha256").update(challenge + nonce).digest("hex");
    const leadingZeros = hash.match(/^0+/)?.[0].length || 0;

    if (leadingZeros < challengeData.difficulty) {
      return reply.code(400).send({
        error: `Invalid proof-of-work. Need ${challengeData.difficulty} leading zeros, got ${leadingZeros}`,
        code: "GEN_002",
      });
    }

    _challenges.delete(challenge);

    // Generate short app token (valid 5 min)
    const tokenExpiresAt = Date.now() + 5 * 60 * 1000;
    const appToken = generateAppToken(projectId, req.ip, tokenExpiresAt);

    return {
      ok: true,
      app_token: appToken,
      expires_in: 300,
    };
  });
};

const {
  db,
  quoteIdent,
  projectRoute,
  generateToken,
  consumeEmailVerificationToken,
  createEmailVerificationToken,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");
const { enqueueEmail } = require("../../../../lib/v2/queue");
const { ensureV2Tables } = require("../../../../lib/v2/schema");

module.exports = async function (fastify) {
  // GET /auth/verify-email?token=xxx
  // Uses hashed token comparison (v2 security improvement)
  projectRoute(fastify, "GET", "/auth/verify-email", {
    config: { rateLimit: { max: 20, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const token = String(req.query?.token || "").trim();
    if (!token) return reply.code(400).send({ error: "token is required", code: "GEN_002" });

    await ensureV2Tables(schemaName).catch(() => {});

    // consumeEmailVerificationToken handles hash comparison and marks as used
    const result = await consumeEmailVerificationToken(schemaName, token);
    if (!result) return reply.code(400).send({ error: "Invalid or expired token", code: "AUTH_008" });

    return { ok: true, user_id: result.user_id };
  });

  // POST /auth/resend-verification  { email?, userId?, login_url? }
  projectRoute(fastify, "POST", "/auth/resend-verification", {
    config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          email:     { type: "string", format: "email", maxLength: 254 },
          userId:    { type: "string", format: "uuid" },
          login_url: { type: "string", format: "uri", maxLength: 2048 },
        },
      },
    },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const email    = String(req.body?.email    || "").trim().toLowerCase();
    const userId   = String(req.body?.userId   || "").trim();
    const loginUrl = String(req.body?.login_url || "").trim();
    if (!email && !userId) return reply.code(400).send({ error: "email or userId is required", code: "GEN_002" });

    const s = quoteIdent(schemaName);
    const userRes = userId
      ? await db.query(`SELECT id, email, email_verified FROM ${s}._auth_users WHERE id = $1 LIMIT 1`, [userId])
      : await db.query(`SELECT id, email, email_verified FROM ${s}._auth_users WHERE email = $1 LIMIT 1`, [email]);

    // Always return ok to avoid user enumeration
    if (!userRes.rows[0]) return { ok: true };
    if (userRes.rows[0].email_verified) return reply.code(400).send({ error: "Email already verified", code: "AUTH_009" });

    await ensureV2Tables(schemaName).catch(() => {});

    const toEmail = userRes.rows[0].email;
    const projectRow  = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    const projectName = projectRow.rows[0]?.name ?? "App";

    createEmailVerificationToken(schemaName, userRes.rows[0].id)
      .then(rawToken => {
        const verifyUrl = loginUrl
          ? `${new URL(loginUrl).origin}/auth/verify-email?token=${rawToken}`
          : rawToken;
        enqueueEmail(schemaName, projectName, {
          to:              toEmail,
          templateName:    "email_verification",
          vars:            { "user.email": toEmail, "verify_url": verifyUrl, "login_url": loginUrl },
          fallbackSubject: `Verificá tu email — ${projectName}`,
          fallbackHtml:    `<p>Verificá tu cuenta: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
        });
      })
      .catch(err => fastify.log.warn({ step: "resend_verification", error: err.message }));

    return { ok: true };
  });
};

// ─── Auth v2 ──────────────────────────────────────────────────────────────────
//
// Extiende las funciones de autenticación de v1 con:
//   - hashToken / verifyHashedToken para tokens sensibles
//   - createPasswordResetToken / verifyPasswordResetToken (hashed)
//   - createEmailVerificationToken / verifyEmailVerificationToken (hashed)
//   - Re-exporta todo lo demás de lib/matecito sin cambios

const crypto = require("crypto");
const db      = require("../../db");
const {
  quoteIdent,
  generateToken,
  requirePlatformAuth,
  requireProjectAuth,
  requireProjectOrPlatformAuth,
  requireProjectApiKey,
  flexAuth,
  createPlatformRefreshToken,
  rotatePlatformRefreshToken,
  createProjectRefreshToken,
  rotateProjectRefreshToken,
  getProjectByAnonKey,
  getProjectKeyContext,
  logAuthEvent,
  isWorkspaceMember,
  isProjectMember,
  createProjectSchema,
  dropProjectSchema,
  generateSchemaName,
  sendProjectEmail,
  projectRoute,
} = require("../matecito");

// ─── Hashing helpers ──────────────────────────────────────────────────────────

/**
 * Hash un token raw con SHA-256.
 * Se guarda el hash en DB; el token raw va al usuario (en URL o email).
 */
function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Verifica que `raw` hashea al `hashed` almacenado.
 * Timing-safe comparison.
 */
function verifyHashedToken(raw, hashed) {
  const computed = hashToken(raw);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hashed,   "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Password Reset v2 (tokens hasheados) ────────────────────────────────────

/**
 * Crea un token de reset de contraseña y lo guarda hasheado en DB.
 * Devuelve el token raw (para incluir en el link del email).
 */
async function createPasswordResetToken(schemaName, userId) {
  const s       = quoteIdent(schemaName);
  const raw     = generateToken(32);
  const hashed  = hashToken(raw);
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

  // Invalidar tokens previos
  await db.query(
    `UPDATE ${s}._password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  await db.query(
    `INSERT INTO ${s}._password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashed, expires]
  );

  return raw; // raw va al usuario
}

/**
 * Verifica un token de reset de contraseña.
 * Devuelve la fila si es válida, null si no.
 */
async function verifyPasswordResetToken(schemaName, rawToken) {
  const s      = quoteIdent(schemaName);
  const hashed = hashToken(rawToken);

  const { rows } = await db.query(
    `SELECT * FROM ${s}._password_resets
     WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL
     LIMIT 1`,
    [hashed]
  );

  return rows[0] ?? null;
}

/**
 * Marca como usado un token de reset por su ID.
 */
async function consumePasswordResetToken(schemaName, tokenId) {
  const s = quoteIdent(schemaName);
  await db.query(
    `UPDATE ${s}._password_resets SET used_at = NOW() WHERE id = $1`,
    [tokenId]
  );
}

// ─── Email Verification v2 (tokens hasheados) ─────────────────────────────────

/**
 * Crea un token de verificación de email hasheado en DB.
 * Devuelve el token raw.
 */
async function createEmailVerificationToken(schemaName, userId) {
  const s       = quoteIdent(schemaName);
  const raw     = generateToken(32);
  const hashed  = hashToken(raw);
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas

  await db.query(
    `INSERT INTO ${s}._email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashed, expires]
  );

  return raw;
}

/**
 * Verifica un token de email.
 * Devuelve la fila si es válida, null si no.
 */
async function verifyEmailToken(schemaName, rawToken) {
  const s      = quoteIdent(schemaName);
  const hashed = hashToken(rawToken);

  const { rows } = await db.query(
    `SELECT * FROM ${s}._email_verifications
     WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL
     LIMIT 1`,
    [hashed]
  );

  return rows[0] ?? null;
}

/**
 * Verifica un token raw, lo marca como usado, y marca email_verified en _auth_users.
 * Devuelve { user_id } si es válido, null si no.
 */
async function consumeEmailVerificationToken(schemaName, rawToken) {
  const s      = quoteIdent(schemaName);
  const hashed = hashToken(rawToken);

  const { rows } = await db.query(
    `SELECT id, user_id, expires_at, used_at FROM ${s}._email_verifications
     WHERE token = $1 LIMIT 1`,
    [hashed]
  );

  const row = rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  await db.query(
    `UPDATE ${s}._email_verifications SET used_at = NOW() WHERE id = $1`,
    [row.id]
  );
  await db.query(
    `UPDATE ${s}._auth_users SET email_verified = TRUE, email_verified_at = NOW() WHERE id = $1`,
    [row.user_id]
  );

  return { user_id: row.user_id };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Nuevas funciones v2
  hashToken,
  verifyHashedToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
  createEmailVerificationToken,
  verifyEmailToken,
  consumeEmailVerificationToken,

  // Re-exports de v1 sin cambios
  db,
  quoteIdent,
  generateToken,
  requirePlatformAuth,
  requireProjectAuth,
  requireProjectOrPlatformAuth,
  requireProjectApiKey,
  flexAuth,
  createPlatformRefreshToken,
  rotatePlatformRefreshToken,
  createProjectRefreshToken,
  rotateProjectRefreshToken,
  getProjectByAnonKey,
  getProjectKeyContext,
  logAuthEvent,
  isWorkspaceMember,
  isProjectMember,
  createProjectSchema,
  dropProjectSchema,
  generateSchemaName,
  sendProjectEmail,
  projectRoute,
};

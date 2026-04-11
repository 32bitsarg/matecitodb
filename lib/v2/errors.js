// ─── Códigos de error estandarizados ─────────────────────────────────────────
//
// Formato: DOMAIN_NNN
// Uso:     return apiError(reply, "AUTH_001")
//          return apiError(reply, "AUTH_001", "Custom override message")

const ERRORS = {
  // Auth
  AUTH_001: { status: 401, message: "Unauthorized" },
  AUTH_002: { status: 401, message: "Invalid or expired token" },
  AUTH_003: { status: 401, message: "Invalid credentials" },
  AUTH_004: { status: 401, message: "Token expired" },
  AUTH_005: { status: 400, message: "email and password are required" },
  AUTH_006: { status: 400, message: "Password must be at least 8 characters" },
  AUTH_007: { status: 409, message: "User already exists" },
  AUTH_008: { status: 400, message: "Invalid or expired verification token" },
  AUTH_009: { status: 400, message: "Email already verified" },
  AUTH_010: { status: 400, message: "Invalid or expired reset token" },
  AUTH_011: { status: 400, message: "OAuth code is invalid or expired" },
  AUTH_012: { status: 400, message: "OAuth provider error" },

  // Permissions
  PERM_001: { status: 403, message: "Forbidden" },
  PERM_002: { status: 403, message: "Access denied" },
  PERM_003: { status: 403, message: "Service key required" },
  PERM_004: { status: 403, message: "API key scope does not allow this operation" },
  PERM_005: { status: 403, message: "Insufficient workspace role" },

  // Data / Records
  DATA_001: { status: 404, message: "Record not found" },
  DATA_002: { status: 404, message: "Collection not found" },
  DATA_003: { status: 400, message: "collection is required" },
  DATA_004: { status: 400, message: "data must be a plain object" },
  DATA_005: { status: 400, message: "Invalid field value" },
  DATA_006: { status: 400, message: "Required field missing" },
  DATA_007: { status: 400, message: "Invalid expires_at" },
  DATA_008: { status: 400, message: "SQL statement not allowed" },
  DATA_009: { status: 403, message: "SQL endpoint is disabled for this project" },

  // Project / Platform
  PROJ_001: { status: 404, message: "Project not found" },
  PROJ_002: { status: 404, message: "Workspace not found" },
  PROJ_003: { status: 400, message: "projectId required" },
  PROJ_004: { status: 400, message: "Invalid project key" },
  PROJ_005: { status: 403, message: "Invalid project key" },

  // Storage
  STOR_001: { status: 400, message: "File required" },
  STOR_002: { status: 400, message: "Only image files are supported" },
  STOR_003: { status: 413, message: "Storage quota exceeded" },
  STOR_004: { status: 404, message: "File not found" },

  // Jobs
  JOB_001:  { status: 404, message: "Job not found" },

  // Generic
  GEN_001:  { status: 400, message: "Bad request" },
  GEN_002:  { status: 400, message: "Bad request" },
  GEN_003:  { status: 404, message: "Not found" },
  GEN_004:  { status: 409, message: "Conflict" },
  GEN_005:  { status: 502, message: "Upstream error" },
};

/**
 * Envía una respuesta de error estandarizada.
 * @param {object} reply      - Fastify reply object
 * @param {string} code       - Código de error (ej: "AUTH_001")
 * @param {string} [message]  - Override del mensaje por defecto
 * @param {object} [extra]    - Campos extra para incluir en la respuesta
 */
function apiError(reply, code, message, extra = {}) {
  const def = ERRORS[code];
  if (!def) {
    return reply.code(500).send({ error: "Unknown error", code });
  }
  return reply.code(def.status).send({
    error: message ?? def.message,
    code,
    ...extra,
  });
}

module.exports = { ERRORS, apiError };

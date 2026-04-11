// ─── OAuth One-Time Code Exchange ─────────────────────────────────────────────
//
// Solución al problema de v1 donde los tokens van en query params de URL.
//
// Flujo v2:
//   1. Callback OAuth → genera code (short-lived, 60s) → redirige a redirect_uri?code=CODE
//   2. Cliente hace POST /auth/oauth/exchange { code } → recibe { access_token, refresh_token }
//   3. El code se consume (one-time use)

const crypto = require("crypto");

const _store  = new Map(); // code → { access_token, refresh_token, user, exp }
const CODE_TTL = 60_000;  // 60 segundos

// Limpiar códigos expirados cada minuto
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _store) {
    if (v.exp < now) _store.delete(k);
  }
}, 60_000).unref();

/**
 * Crea un código one-time para el intercambio OAuth.
 * @param {object} data — { access_token, refresh_token, user, projectId }
 * @returns {string} code — hex string de 32 bytes
 */
function createOAuthCode(data) {
  const code = crypto.randomBytes(32).toString("hex");
  _store.set(code, { ...data, exp: Date.now() + CODE_TTL });
  return code;
}

/**
 * Consume y devuelve los datos de un código OAuth.
 * One-time use: el código se elimina al leerlo.
 * @returns {object|null}
 */
function consumeOAuthCode(code) {
  const data = _store.get(code);
  if (!data || data.exp < Date.now()) {
    _store.delete(code);
    return null;
  }
  _store.delete(code);
  return data;
}

module.exports = { createOAuthCode, consumeOAuthCode };

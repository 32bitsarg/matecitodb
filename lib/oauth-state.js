const crypto = require("crypto");

// State temporal para OAuth CSRF protection
// No necesita persistencia — expira en 10 minutos
const stateStore = new Map(); // state → { projectId, schemaName, redirectUri, provider, exp }
const STATE_TTL   = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (v.exp < now) stateStore.delete(k);
  }
}, 60_000).unref();

function createOAuthState(data) {
  const state = crypto.randomBytes(32).toString("hex");
  stateStore.set(state, { ...data, exp: Date.now() + STATE_TTL });
  return state;
}

function consumeOAuthState(state) {
  const data = stateStore.get(state);
  if (!data || data.exp < Date.now()) return null;
  stateStore.delete(state);
  return data;
}

module.exports = { createOAuthState, consumeOAuthState };

// ─── Response Cache (Q1) — Redis/in-memory con invalidación por write ───────

const { getClient } = require("./redis");

const _localCache = new Map(); // fallback in-memory
const _localTTL = new Map();
const _stats = { hits: 0, misses: 0 };

function cacheKey(schemaName, collection, varyValue, queryHash) {
  return `cache:${schemaName}:${collection}:${varyValue || ""}:${queryHash || "all"}`;
}

async function get(key) {
  const client = getClient();
  if (client) {
    try {
      const val = await client.get(key);
      if (val) { _stats.hits++; return JSON.parse(val); }
      _stats.misses++;
      return null;
    } catch { /* fallback to local */ }
  }

  // Local cache
  if (_localCache.has(key) && _localTTL.get(key) > Date.now()) {
    _stats.hits++;
    return _localCache.get(key);
  }
  _localCache.delete(key);
  _localTTL.delete(key);
  _stats.misses++;
  return null;
}

async function set(key, value, ttlSeconds) {
  const client = getClient();
  if (client) {
    try {
      await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch { /* fallback to local */ }
  }

  _localCache.set(key, value);
  _localTTL.set(key, Date.now() + ttlSeconds * 1000);
}

async function purge(keyOrPattern) {
  const client = getClient();
  if (client) {
    try {
      if (keyOrPattern.includes("*")) {
        const keys = await client.keys(keyOrPattern);
        if (keys.length > 0) await client.del(...keys);
      } else {
        await client.del(keyOrPattern);
      }
    } catch { /* ignore */ }
  }

  // Purge local
  if (keyOrPattern.includes("*")) {
    const pattern = keyOrPattern.replace(/\*/g, "");
    for (const [k] of _localCache) {
      if (k.includes(pattern)) {
        _localCache.delete(k);
        _localTTL.delete(k);
      }
    }
  } else {
    _localCache.delete(keyOrPattern);
    _localTTL.delete(keyOrPattern);
  }
}

async function purgeCollection(schemaName, collection) {
  const pattern = `cache:${schemaName}:${collection}:*`;
  await purge(pattern);
}

function getStats() {
  const total = _stats.hits + _stats.misses;
  return {
    hits: _stats.hits,
    misses: _stats.misses,
    hit_rate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : "0.0",
    local_keys: _localCache.size,
  };
}

module.exports = { get, set, purge, purgeCollection, cacheKey, getStats };

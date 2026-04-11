// ─── Redis client (opcional) ──────────────────────────────────────────────────
//
// Si REDIS_URL está configurado, crea un cliente IORedis.
// Si no, todos los módulos v2 caen back a in-memory.
//
// Uso:
//   const { redis } = require("./redis");
//   if (redis) { await redis.set(key, val); }

let redis = null;

if (process.env.REDIS_URL) {
  try {
    const IORedis = require("ioredis");
    redis = new IORedis(process.env.REDIS_URL, {
      lazyConnect:          true,
      enableOfflineQueue:   false,
      maxRetriesPerRequest: 3,
      connectTimeout:       5000,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
    });

    redis.on("error", (err) => {
      console.warn("[redis] Connection error:", err.message);
    });

    redis.on("connect", () => {
      console.info("[redis] Connected");
    });

    // Conectar en background — no bloquea el inicio del servidor
    redis.connect().catch((err) => {
      console.warn("[redis] Could not connect:", err.message);
    });
  } catch (err) {
    console.warn("[redis] ioredis not available, using in-memory fallback:", err.message);
    redis = null;
  }
} else {
  console.info("[redis] REDIS_URL not set, using in-memory fallback for caches");
}

module.exports = { redis };

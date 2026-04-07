const admin = require("firebase-admin");

// Cache de apps por project_id de Firebase
const _apps = new Map();

function getApp(credentials) {
  // Si se pasan credenciales del proyecto, usarlas
  if (credentials) {
    const key = credentials.project_id;
    if (_apps.has(key)) return _apps.get(key);
    const app = admin.initializeApp(
      { credential: admin.credential.cert(credentials) },
      key  // nombre único para esta app Firebase
    );
    _apps.set(key, app);
    return app;
  }

  // Fallback: credenciales globales del servidor (retrocompatibilidad)
  if (_apps.has("__global__")) return _apps.get("__global__");

  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!keyPath && !keyJson) {
    throw new Error(
      "FCM not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON in .env, or configure Firebase in the project dashboard."
    );
  }

  const credential = keyJson
    ? admin.credential.cert(JSON.parse(keyJson))
    : admin.credential.cert(require(keyPath));

  const app = admin.initializeApp({ credential }, "__global__");
  _apps.set("__global__", app);
  return app;
}

/**
 * Send a push notification to one or more FCM tokens.
 * @param {string[]} tokens
 * @param {{ title: string, body: string }} notification
 * @param {Record<string, string>} [data]
 * @param {object|null} [credentials]  — Firebase service account for this project
 * @returns {{ successCount: number, failureCount: number, invalidTokens: string[] }}
 */
async function sendToTokens(tokens, notification, data = {}, credentials = null) {
  const app = getApp(credentials);
  const tokenList = Array.isArray(tokens) ? tokens : [tokens];
  if (tokenList.length === 0) return { successCount: 0, failureCount: 0, invalidTokens: [] };

  // Stringify all data values (FCM requires string map)
  const safeData = {};
  for (const [k, v] of Object.entries(data)) {
    safeData[k] = String(v);
  }

  const message = {
    notification: { title: notification.title, body: notification.body },
    data: safeData,
    android: {
      priority: "high",
      notification: { sound: "default", channelId: "matecitodb_default" },
    },
    apns: {
      payload: { aps: { sound: "default", badge: 1 } },
    },
  };

  let successCount = 0;
  let failureCount = 0;
  const invalidTokens = [];
  const errors = [];

  const chunks = [];
  for (let i = 0; i < tokenList.length; i += 500) {
    chunks.push(tokenList.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    const res = await admin.messaging(app).sendEachForMulticast({
      ...message,
      tokens: chunk,
    });

    successCount += res.successCount;
    failureCount += res.failureCount;

    res.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.code;
        const msg  = r.error?.message ?? "unknown";
        console.error(`[FCM] Token failed — code: ${code}, message: ${msg}`);
        if (!errors.find(e => e.code === code)) errors.push({ code, message: msg });
        if (
          code === "messaging/invalid-registration-token" ||
          code === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(chunk[idx]);
        }
      }
    });
  }

  return { successCount, failureCount, invalidTokens, errors };
}

module.exports = { sendToTokens };

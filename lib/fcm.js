const admin = require("firebase-admin");

let _app = null;

function getApp() {
  if (_app) return _app;

  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!keyPath && !keyJson) {
    throw new Error(
      "FCM not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON in .env"
    );
  }

  const credential = keyJson
    ? admin.credential.cert(JSON.parse(keyJson))
    : admin.credential.cert(require(keyPath));

  _app = admin.initializeApp({ credential });
  return _app;
}

/**
 * Send a push notification to one or more FCM tokens.
 * @param {string|string[]} tokens
 * @param {{ title: string, body: string }} notification
 * @param {Record<string, string>} [data]  — extra key/value payload (all strings)
 * @returns {{ successCount: number, failureCount: number, invalidTokens: string[] }}
 */
async function sendToTokens(tokens, notification, data = {}) {
  const app = getApp();
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

  // sendEachForMulticast handles up to 500 tokens per call
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
        if (
          code === "messaging/invalid-registration-token" ||
          code === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(chunk[idx]);
        }
      }
    });
  }

  return { successCount, failureCount, invalidTokens };
}

module.exports = { sendToTokens };

const {
  db,
  requireProjectApiKey,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { realtimeBus } = require("../../../../lib/v2/realtime");

/**
 * WebSocket auth — three modes:
 * 1. Header x-matecito-key or query ?key=: API key (anon/service)
 * 2. Query ?token=PROJECT_JWT: authenticated app user
 * 3. Query ?token=PLATFORM_JWT: dashboard admin
 */
async function wsAuth(req, reply) {
  const projectId = req.params?.projectId ?? req.resolvedProject?.id;

  const rawKey = req.headers["x-matecito-key"] || req.query?.key;
  if (rawKey) {
    req.headers["x-matecito-key"] = rawKey;
    return requireProjectApiKey(["anon", "service"])(req, reply);
  }

  const token = req.query?.token;
  if (token) {
    try {
      const payload = await req.server.jwt.verify(token);
      if (!payload?.sub) return reply.code(401).send({ error: "Unauthorized", code: "AUTH_001" });

      if (payload.kind === "project") {
        req.wsAuth = { kind: "project", userId: payload.sub, pid: payload.pid };
        return;
      }

      if (payload.kind === "platform") {
        if (!projectId) return reply.code(400).send({ error: "projectId required", code: "GEN_002" });

        const { rows } = await db.query(
          `SELECT p.id FROM projects p
           JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
           WHERE p.id = $1 AND wm.user_id = $2 LIMIT 1`,
          [projectId, payload.sub]
        );
        if (!rows[0]) return reply.code(403).send({ error: "Forbidden", code: "PERM_001" });

        req.wsAuth = { kind: "platform", userId: payload.sub };
        return;
      }

      return reply.code(401).send({ error: "Unauthorized", code: "AUTH_001" });
    } catch {
      return reply.code(401).send({ error: "Unauthorized", code: "AUTH_001" });
    }
  }

  return reply.code(401).send({ error: "Authentication required", code: "AUTH_001" });
}

module.exports = async function (fastify) {
  const handler = (connection, req) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    // Subscription state
    connection.subscribedCollection = null;
    connection.subscribeFilter       = null;
    connection.subscribedUserId      = null; // for _notifications:{userId}

    const matchesFilter = (event) => {
      // Notification subscription: match by userId
      if (connection.subscribedUserId) {
        return event.userId === connection.subscribedUserId || event.user_id === connection.subscribedUserId;
      }

      if (!connection.subscribedCollection) return true;
      if (event.collection !== connection.subscribedCollection) return false;
      if (!connection.subscribeFilter) return true;

      // Check each filter key against event.record.data
      const data = event.record?.data ?? event.data ?? {};
      for (const [key, val] of Object.entries(connection.subscribeFilter)) {
        if (String(data[key]) !== String(val)) return false;
      }
      return true;
    };

    const onFilteredEvent = (event) => {
      if (connection.socket.readyState !== 1) return;
      if (!matchesFilter(event)) return;
      connection.socket.send(JSON.stringify(event));
    };

    realtimeBus.on(`project:${projectId}`, onFilteredEvent);

    connection.socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "ping") {
        connection.socket.send(JSON.stringify({ type: "pong" }));
      }
      if (msg.type === "subscribe") {
        // Special case: subscribe to user notifications
        if (msg.collection === "_notifications" && msg.filter?.user_id) {
          // Only allow subscribing to own notifications
          const authUserId = req.wsAuth?.kind === "project" ? req.wsAuth.userId : null;
          if (authUserId && msg.filter.user_id === authUserId) {
            connection.subscribedUserId = msg.filter.user_id;
            connection.subscribedCollection = "_notifications";
            connection.socket.send(JSON.stringify({
              type: "subscribed",
              collection: "_notifications",
              user_id: authUserId,
            }));
          } else {
            connection.socket.send(JSON.stringify({ type: "error", message: "Can only subscribe to own notifications" }));
          }
          return;
        }

        connection.subscribedCollection = msg.collection ?? null;
        // filter: { field: value } — only emit events matching all conditions
        connection.subscribeFilter = (msg.filter && typeof msg.filter === "object") ? msg.filter : null;
        connection.socket.send(JSON.stringify({ type: "subscribed", collection: msg.collection, filter: connection.subscribeFilter }));
      }
      if (msg.type === "unsubscribe") {
        connection.subscribedCollection = null;
        connection.subscribeFilter       = null;
        connection.subscribedUserId      = null;
      }
    });

    connection.socket.on("close", () => {
      realtimeBus.off(`project:${projectId}`, onFilteredEvent);
    });
  };

  projectRoute(fastify, "GET", "/ws", { websocket: true, preHandler: wsAuth }, handler);
};

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
    // For subdomain routing, projectId is in resolvedProject, not params
    if (!req.params.projectId && req.resolvedProject?.id) {
      req.params.projectId = req.resolvedProject.id;
    }
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
  const handler = (socket, req) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    // Subscription state
    let subscribedCollection = null;
    let subscribeFilter      = null;
    let subscribedUserId     = null;

    const matchesFilter = (event) => {
      if (subscribedUserId) {
        return event.userId === subscribedUserId || event.user_id === subscribedUserId;
      }
      if (!subscribedCollection) return true;
      if (event.collection !== subscribedCollection) return false;
      if (!subscribeFilter) return true;
      const data = event.record?.data ?? event.data ?? {};
      for (const [key, val] of Object.entries(subscribeFilter)) {
        if (String(data[key]) !== String(val)) return false;
      }
      return true;
    };

    const onFilteredEvent = (event) => {
      if (socket.readyState !== 1) return;
      if (!matchesFilter(event)) return;
      socket.send(JSON.stringify(event));
    };

    realtimeBus.on(`project:${projectId}`, onFilteredEvent);

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
      if (msg.type === "subscribe") {
        if (msg.collection === "_notifications" && msg.filter?.user_id) {
          const authUserId = req.wsAuth?.kind === "project" ? req.wsAuth.userId : null;
          if (authUserId && msg.filter.user_id === authUserId) {
            subscribedUserId     = msg.filter.user_id;
            subscribedCollection = "_notifications";
            socket.send(JSON.stringify({ type: "subscribed", collection: "_notifications", user_id: authUserId }));
          } else {
            socket.send(JSON.stringify({ type: "error", message: "Can only subscribe to own notifications" }));
          }
          return;
        }
        subscribedCollection = msg.collection ?? null;
        subscribeFilter      = (msg.filter && typeof msg.filter === "object") ? msg.filter : null;
        socket.send(JSON.stringify({ type: "subscribed", collection: msg.collection, filter: subscribeFilter }));
      }
      if (msg.type === "unsubscribe") {
        subscribedCollection = null;
        subscribeFilter      = null;
        subscribedUserId     = null;
      }
    });

    socket.on("close", () => {
      realtimeBus.off(`project:${projectId}`, onFilteredEvent);
    });
  };

  projectRoute(fastify, "GET", "/ws", { websocket: true, preHandler: wsAuth }, handler);
};

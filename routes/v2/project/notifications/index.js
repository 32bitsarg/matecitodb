// ─── Notification Center — In-app notifications (J2) ────────────────────────
//
// POST   /notifications              → enviar a uno o más usuarios (service key)
// POST   /notifications/broadcast    → enviar a todos
// GET    /notifications/me           → mis notificaciones (cursor-based)
// GET    /notifications/me/unread-count
// PATCH  /notifications/:id/read     → marcar leída
// PATCH  /notifications/me/read-all  → marcar todas leídas
// DELETE /notifications/:id          → eliminar

const {
  db,
  flexAuth,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { ensureV2Tables }    = require("../../../../lib/v2/schema");
const { emitProjectEvent }  = require("../../../../lib/v2/realtime");
const { apiError }          = require("../../../../lib/v2/errors");

// ── Cursor-based pagination helpers ─────────────────────────────────────────
function encodeCursor(val) {
  return Buffer.from(JSON.stringify(val)).toString("base64url");
}
function decodeCursor(raw) {
  try { return JSON.parse(Buffer.from(raw, "base64url").toString()); }
  catch { return null; }
}

// ── Validation helpers ───────────────────────────────────────────────────────
const VALID_TYPES = ["info", "success", "warning", "error"];

async function createNotification(schemaName, userId, title, body, type, data, projectId) {
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `INSERT INTO ${schema}._notifications (user_id, title, body, type, data)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, title, body || null, type, JSON.stringify(data || {})]
  );

  // Emitir via realtime al canal del usuario
  emitProjectEvent(projectId, {
    type: "notification.created",
    userId,
    notification: rows[0],
  }).catch(() => {});

  return rows[0];
}

module.exports = async function (fastify) {
  // ── POST /notifications ──────────────────────────────────────────────────
  fastify.post("/notifications", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["user_ids", "title"],
        properties: {
          user_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 },
          title:    { type: "string", minLength: 1 },
          body:     { type: "string" },
          type:     { type: "string", enum: VALID_TYPES },
          data:     { type: "object" },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { user_ids, title, body, type = "info", data = {} } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const results = [];
    for (const userId of user_ids) {
      const notif = await createNotification(schemaName, userId, title, body, type, data, projectId);
      results.push({ user_id: userId, id: notif.id });
    }

    return reply.code(201).send({ created: results.length, notifications: results });
  });

  // ── POST /notifications/broadcast ────────────────────────────────────────
  fastify.post("/notifications/broadcast", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["title"],
        properties: {
          title:    { type: "string", minLength: 1 },
          body:     { type: "string" },
          type:     { type: "string", enum: VALID_TYPES },
          data:     { type: "object" },
          user_ids: { type: "array", items: { type: "string" } }, // optional: subset
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { title, body, type = "info", data = {}, user_ids } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    // Get target users
    let targetUsers;
    if (user_ids && user_ids.length > 0) {
      targetUsers = user_ids;
    } else {
      // All users with at least one record (active users)
      const { rows } = await db.query(
        `SELECT DISTINCT data->>'created_by' AS user_id FROM ${schema}._records
         WHERE data->>'created_by' IS NOT NULL AND deleted_at IS NULL
         LIMIT 10000`
      );
      targetUsers = rows.map(r => r.user_id).filter(Boolean);

      // Also get users from _auth_users
      const { rows: authRows } = await db.query(
        `SELECT id FROM ${schema}._auth_users LIMIT 10000`
      );
      const authIds = new Set(authRows.map(r => r.id));
      for (const uid of targetUsers) authIds.add(uid);
      targetUsers = [...authIds];
    }

    // Batch insert
    const created = [];
    for (const userId of targetUsers) {
      const notif = await createNotification(schemaName, userId, title, body, type, data, projectId);
      created.push({ user_id: userId, id: notif.id });
    }

    return reply.code(201).send({ broadcast: true, sent_to: created.length, notifications: created });
  });

  // ── GET /notifications/me ────────────────────────────────────────────────
  fastify.get("/notifications/me", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!req.projectUser) return apiError(reply, "AUTH_001");

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const userId = req.projectUser.id;
    const { limit = "50", cursor, unread_only } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    const where = [`user_id = $1`];
    const values = [userId];

    if (unread_only === "true") where.push(`read_at IS NULL`);

    if (cursor) {
      const cur = decodeCursor(cursor);
      if (cur) {
        values.push(cur.created_at, cur.id);
        where.push(`(created_at < $${values.length - 1} OR (created_at = $${values.length - 1} AND id < $${values.length}))`);
      }
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    const { rows } = await db.query(
      `SELECT * FROM ${schema}._notifications
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 1}`,
      [...values, limitNum]
    );

    let nextCursor = null;
    if (rows.length === limitNum) {
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor({ created_at: last.created_at, id: last.id });
    }

    return {
      notifications: rows.map(r => ({
        id: r.id,
        user_id: r.user_id,
        title: r.title,
        body: r.body,
        type: r.type,
        data: r.data,
        read_at: r.read_at,
        created_at: r.created_at,
      })),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
    };
  });

  // ── GET /notifications/me/unread-count ───────────────────────────────────
  fastify.get("/notifications/me/unread-count", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!req.projectUser) return apiError(reply, "AUTH_001");

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT COUNT(*) FROM ${schema}._notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.projectUser.id]
    );

    return { unread_count: parseInt(rows[0].count, 10) };
  });

  // ── PATCH /notifications/:id/read ────────────────────────────────────────
  fastify.patch("/notifications/:id/read", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!req.projectUser) return apiError(reply, "AUTH_001");

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { id } = req.params;

    const { rows } = await db.query(
      `UPDATE ${schema}._notifications SET read_at = NOW()
       WHERE id = $1 AND user_id = $2 AND read_at IS NULL
       RETURNING *`,
      [id, req.projectUser.id]
    );

    if (!rows[0]) return apiError(reply, "GEN_003", "Notification not found or already read");

    return { ok: true, notification: { id: rows[0].id, read_at: rows[0].read_at } };
  });

  // ── PATCH /notifications/me/read-all ─────────────────────────────────────
  fastify.patch("/notifications/me/read-all", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!req.projectUser) return apiError(reply, "AUTH_001");

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rowCount } = await db.query(
      `UPDATE ${schema}._notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [req.projectUser.id]
    );

    return { marked_read: rowCount };
  });

  // ── DELETE /notifications/:id ────────────────────────────────────────────
  fastify.delete("/notifications/:id", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!req.projectUser) return apiError(reply, "AUTH_001");

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { id } = req.params;

    const { rowCount } = await db.query(
      `DELETE FROM ${schema}._notifications WHERE id = $1 AND user_id = $2`,
      [id, req.projectUser.id]
    );

    if (rowCount === 0) return apiError(reply, "GEN_003", "Notification not found");

    return { deleted: id };
  });
};

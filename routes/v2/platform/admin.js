const { db, requireAdmin } = require("../../../lib/v2/auth");

module.exports = async function (fastify) {

  // ── GET /admin/stats ──────────────────────────────────────────────────────
  // Stats generales de toda la plataforma
  fastify.get("/admin/stats", { preHandler: requireAdmin }, async (req, reply) => {
    const [
      usersRes,
      workspacesRes,
      projectsRes,
      v1Res,
      v2Res,
      newUsersRes,
      storageRes,
    ] = await Promise.all([
      db.query("SELECT COUNT(*) AS total FROM public.users"),
      db.query("SELECT COUNT(*) AS total FROM public.workspaces"),
      db.query("SELECT COUNT(*) AS total FROM public.projects"),
      db.query("SELECT COUNT(*) AS total FROM public.projects WHERE api_version = 'v1' OR api_version IS NULL"),
      db.query("SELECT COUNT(*) AS total FROM public.projects WHERE api_version = 'v2'"),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')  AS last_24h,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS last_7d,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS last_30d
        FROM public.users
      `),
      db.query(`
        SELECT COALESCE(SUM(size), 0) AS total_bytes
        FROM public.files
      `).catch(() => ({ rows: [{ total_bytes: 0 }] })),
    ]);

    return {
      users: {
        total:    parseInt(usersRes.rows[0].total),
        last_24h: parseInt(newUsersRes.rows[0].last_24h),
        last_7d:  parseInt(newUsersRes.rows[0].last_7d),
        last_30d: parseInt(newUsersRes.rows[0].last_30d),
      },
      workspaces: parseInt(workspacesRes.rows[0].total),
      projects: {
        total: parseInt(projectsRes.rows[0].total),
        v1:    parseInt(v1Res.rows[0].total),
        v2:    parseInt(v2Res.rows[0].total),
      },
      storage_mb: Math.round(parseInt(storageRes.rows[0].total_bytes) / 1024 / 1024),
    };
  });

  // ── GET /admin/users ──────────────────────────────────────────────────────
  // Lista de usuarios con sus workspaces y proyectos
  fastify.get("/admin/users", { preHandler: requireAdmin }, async (req, reply) => {
    const limit  = Math.min(parseInt(req.query.limit  || "50"), 100);
    const offset = parseInt(req.query.offset || "0");
    const search = req.query.search || "";

    const where  = search ? `WHERE u.email ILIKE $3 OR u.username ILIKE $3 OR u.name ILIKE $3` : "";
    const params = search ? [limit, offset, `%${search}%`] : [limit, offset];

    const { rows } = await db.query(`
      SELECT
        u.id, u.email, u.username, u.name, u.is_admin, u.created_at,
        COUNT(DISTINCT wm.workspace_id) AS workspaces,
        COUNT(DISTINCT p.id)            AS projects
      FROM public.users u
      LEFT JOIN public.workspace_members wm ON wm.user_id = u.id
      LEFT JOIN public.projects p ON p.workspace_id = wm.workspace_id
      ${where}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM public.users u ${where}`,
      search ? [`%${search}%`] : []
    );

    return { users: rows, total: parseInt(countRes.rows[0].total), limit, offset };
  });

  // ── GET /admin/projects ───────────────────────────────────────────────────
  fastify.get("/admin/projects", { preHandler: requireAdmin }, async (req, reply) => {
    const limit  = Math.min(parseInt(req.query.limit  || "50"), 100);
    const offset = parseInt(req.query.offset || "0");

    const { rows } = await db.query(`
      SELECT
        p.id, p.name, p.subdomain, p.api_version, p.created_at,
        w.name AS workspace_name,
        u.email AS owner_email
      FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      JOIN public.users u ON u.id = w.owner_id
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countRes = await db.query("SELECT COUNT(*) AS total FROM public.projects");

    return { projects: rows, total: parseInt(countRes.rows[0].total), limit, offset };
  });

  // ── GET /admin/newsletter ─────────────────────────────────────────────────
  fastify.get("/admin/newsletter", { preHandler: requireAdmin }, async (req, reply) => {
    const { rows } = await db.query(`
      SELECT email, source, created_at
      FROM public.newsletter_subscribers
      ORDER BY created_at DESC
      LIMIT 200
    `).catch(() => ({ rows: [] }));

    return { subscribers: rows, total: rows.length };
  });
};

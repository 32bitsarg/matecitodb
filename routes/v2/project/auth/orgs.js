// ─── Orgs (R1) ─────────────────────────────────────────────────────────────
//
// POST   /auth/orgs                    → crear
// GET    /auth/orgs/me                 → mis orgs
// GET    /auth/orgs/:slug              → detalle
// PATCH  /auth/orgs/:slug              → actualizar
// DELETE /auth/orgs/:slug              → eliminar
// GET    /auth/orgs/:slug/members      → miembros
// POST   /auth/orgs/:slug/members      → agregar
// PATCH  /auth/orgs/:slug/members/:userId → cambiar rol
// DELETE /auth/orgs/:slug/members/:userId → quitar

const { db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // POST /auth/orgs
  fastify.post("/auth/orgs", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["name", "slug"], properties: { name: { type: "string" }, slug: { type: "string" }, metadata: { type: "object" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name, slug, metadata } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    try {
      const { rows } = await db.query(`INSERT INTO ${schema}._orgs (name, slug, metadata) VALUES ($1,$2,$3) RETURNING *`, [name, slug, JSON.stringify(metadata || {})]);
      // Add creator as owner
      if (req.projectUser?.id) await db.query(`INSERT INTO ${schema}._org_members (org_id, user_id, role) VALUES ($1,$2,'owner')`, [rows[0].id, req.projectUser.id]);
      return reply.code(201).send({ org: rows[0] });
    } catch (err) { if (err.code === "23505") return reply.code(409).send({ error: "Slug already exists" }); throw err; }
  });

  // GET /auth/orgs/me
  fastify.get("/auth/orgs/me", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const userId = req.projectUser?.id;
    if (!userId) return reply.code(401).send({ error: "Auth required" });
    const { rows } = await db.query(`SELECT o.*, m.role AS member_role FROM ${schema}._orgs o JOIN ${schema}._org_members m ON m.org_id = o.id WHERE m.user_id = $1 ORDER BY o.name`, [userId]);
    return { orgs: rows };
  });

  // GET /auth/orgs/:slug
  fastify.get("/auth/orgs/:slug", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { slug } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._orgs WHERE slug=$1`, [slug]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { org: rows[0] };
  });

  // PATCH /auth/orgs/:slug
  fastify.patch("/auth/orgs/:slug", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", properties: { name: { type: "string" }, metadata: { type: "object" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { slug } = req.params;
    const { name, metadata } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const u = []; const v = [];
    if (name) { v.push(name); u.push(`name=$${v.length}`); }
    if (metadata !== undefined) { v.push(JSON.stringify(metadata)); u.push(`metadata=$${v.length}`); }
    if (!u.length) return reply.code(400).send({ error: "No fields to update" });
    v.push(slug);
    const { rows } = await db.query(`UPDATE ${schema}._orgs SET ${u.join(",")} WHERE slug=$${v.length} RETURNING *`, v);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { org: rows[0] };
  });

  // DELETE /auth/orgs/:slug
  fastify.delete("/auth/orgs/:slug", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { slug } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._orgs WHERE slug=$1`, [slug]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { deleted: slug };
  });

  // GET /auth/orgs/:slug/members
  fastify.get("/auth/orgs/:slug/members", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { slug } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows: org } = await db.query(`SELECT id FROM ${schema}._orgs WHERE slug=$1`, [slug]);
    if (!org[0]) return apiError(reply, "GEN_003");
    const { rows } = await db.query(`SELECT m.user_id, m.role, m.joined_at FROM ${schema}._org_members m WHERE m.org_id=$1 ORDER BY m.joined_at`, [org[0].id]);
    return { org: slug, members: rows };
  });

  // POST /auth/orgs/:slug/members
  fastify.post("/auth/orgs/:slug/members", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["userId"], properties: { userId: { type: "string" }, role: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { slug } = req.params;
    const { userId, role = "member" } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows: org } = await db.query(`SELECT id FROM ${schema}._orgs WHERE slug=$1`, [slug]);
    if (!org[0]) return apiError(reply, "GEN_003");
    const { rows } = await db.query(`INSERT INTO ${schema}._org_members (org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO UPDATE SET role=$3 RETURNING *`, [org[0].id, userId, role]);
    return reply.code(201).send({ member: rows[0] });
  });

  // DELETE /auth/orgs/:slug/members/:userId
  fastify.delete("/auth/orgs/:slug/members/:userId", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { slug, userId } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows: org } = await db.query(`SELECT id FROM ${schema}._orgs WHERE slug=$1`, [slug]);
    if (!org[0]) return apiError(reply, "GEN_003");
    const { rowCount } = await db.query(`DELETE FROM ${schema}._org_members WHERE org_id=$1 AND user_id=$2`, [org[0].id, userId]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { removed: userId };
  });
};

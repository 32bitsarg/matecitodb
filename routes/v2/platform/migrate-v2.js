const { db, requirePlatformAuth, isProjectMember } = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");
const { ensureV2Tables } = require("../../../lib/v2/schema");

/**
 * POST /migrate-v2/:projectId
 *
 * Migra un proyecto de API v1 a v2 (irreversible).
 */
module.exports = async function (fastify) {
  fastify.post("/migrate-v2/:projectId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId        = req.user.id;
    const { projectId } = req.params;

    const membership = await isProjectMember(userId, projectId);
    if (!membership) return apiError(reply, "PERM_001");
    if (!["owner", "admin"].includes(membership.role)) return apiError(reply, "PERM_005");

    const { rows } = await db.query(
      `SELECT id, name, schema_name, api_version FROM projects WHERE id = $1 LIMIT 1`,
      [projectId]
    );
    const project = rows[0];
    if (!project) return apiError(reply, "PROJ_001");

    if (project.api_version === "v2") {
      return reply.code(409).send({ error: "Project is already on API v2" });
    }

    if (!project.schema_name) {
      return reply.code(500).send({ error: "Project has no schema — cannot migrate" });
    }

    await db.query(`UPDATE projects SET api_version = 'v2' WHERE id = $1`, [projectId]);

    try {
      await ensureV2Tables(project.schema_name);
    } catch (err) {
      req.log.error({ step: "ensureV2Tables", projectId, error: err.message });
    }

    return {
      ok: true,
      project: { id: projectId, name: project.name, api_version: "v2" },
    };
  });
};

const { db, requirePlatformAuth, isProjectMember } = require("../../lib/matecito");
const { ensureV2Tables } = require("../../lib/v2/schema");

/**
 * POST /migrate-v2/:projectId
 *
 * Migra un proyecto de API v1 a v2 (irreversible).
 * - Actualiza api_version = 'v2' en la tabla projects
 * - Corre ensureV2Tables para crear las tablas adicionales de v2
 *
 * Requiere: owner o admin del proyecto/workspace.
 */
module.exports = async function (fastify) {
  fastify.post("/migrate-v2/:projectId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { projectId } = req.params;

    // Verificar que el usuario tiene acceso al proyecto
    const membership = await isProjectMember(userId, projectId);
    if (!membership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (!["owner", "admin"].includes(membership.role)) {
      return reply.code(403).send({ error: "Insufficient permissions — owner or admin required" });
    }

    // Buscar el proyecto
    const { rows } = await db.query(
      `SELECT id, name, schema_name, api_version FROM projects WHERE id = $1 LIMIT 1`,
      [projectId]
    );
    const project = rows[0];
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    if (project.api_version === "v2") {
      return reply.code(409).send({ error: "Project is already on API v2" });
    }

    if (!project.schema_name) {
      return reply.code(500).send({ error: "Project has no schema — cannot migrate" });
    }

    // 1. Actualizar api_version
    await db.query(
      `UPDATE projects SET api_version = 'v2' WHERE id = $1`,
      [projectId]
    );

    // 2. Crear tablas v2 en el schema del proyecto (idempotente)
    try {
      await ensureV2Tables(project.schema_name);
    } catch (err) {
      // No revertimos el api_version — las tablas se pueden crear manualmente
      fastify.log.error({ step: "ensureV2Tables", projectId, error: err.message });
    }

    return {
      ok: true,
      project: {
        id:          projectId,
        name:        project.name,
        api_version: "v2",
      },
    };
  });
};

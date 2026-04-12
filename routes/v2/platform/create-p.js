const {
  db,
  requirePlatformAuth,
  isWorkspaceMember,
  generateSchemaName,
  generateToken,
  createProjectSchema,
} = require("../../../lib/v2/auth");
const { apiError } = require("../../../lib/v2/errors");
const { ensureV2Tables } = require("../../../lib/v2/schema");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

function generateSubdomain(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
}

async function resolveUniqueSubdomain(client, base) {
  let subdomain = base;
  let attempt   = 1;
  while (true) {
    const { rows } = await client.query(
      "SELECT id FROM projects WHERE subdomain = $1 LIMIT 1", [subdomain]
    );
    if (rows.length === 0) return subdomain;
    attempt++;
    subdomain = `${base}-${attempt}`;
  }
}

module.exports = async function (fastify) {
  fastify.post("/create-p", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["workspaceId", "name"],
        additionalProperties: false,
        properties: {
          workspaceId:  { type: "string" },
          name:         { type: "string", minLength: 1, maxLength: 64 },
          api_version:  { type: "string", enum: ["v1", "v2"] },
        },
      },
    },
  }, async (req, reply) => {
    const userId      = req.user.id;
    const workspaceId = String(req.body.workspaceId || "").trim();
    const name        = String(req.body.name        || "").trim();
    // El endpoint v2 crea proyectos v2 por defecto, pero permite v1 para compatibilidad
    const apiVersion  = req.body.api_version === 'v1' ? 'v1' : 'v2';

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) return apiError(reply, "PERM_001");
    if (membership.role === "viewer") return apiError(reply, "PERM_005");

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const baseSubdomain = generateSubdomain(name);
      const subdomain     = await resolveUniqueSubdomain(client, baseSubdomain);

      const projectRes = await client.query(
        `INSERT INTO projects (workspace_id, name, subdomain, api_version, storage_quota_mb, log_retention_days, sql_enabled)
         VALUES ($1, $2, $3, $4, 250, 30, false)
         RETURNING id, workspace_id, name, subdomain, api_version, storage_quota_mb, log_retention_days, sql_enabled, created_at`,
        [workspaceId, name, subdomain, apiVersion]
      );

      const project    = projectRes.rows[0];
      const schemaName = generateSchemaName(project.id);

      await client.query(`UPDATE projects SET schema_name = $1 WHERE id = $2`, [schemaName, project.id]);
      await createProjectSchema(client, schemaName);

      // Inicializar tablas v2 cuando el proyecto lo requiere
      if (apiVersion === 'v2') {
        await ensureV2Tables(schemaName).catch(() => {});
      }

      const anonKey    = `anon_${generateToken(24)}`;
      const serviceKey = `srv_${generateToken(32)}`;

      await client.query(
        `INSERT INTO api_keys (project_id, key, type) VALUES ($1, $2, 'anon'), ($1, $3, 'service')`,
        [project.id, anonKey, serviceKey]
      );

      await client.query("COMMIT");

      return reply.code(201).send({
        project: { ...project, schema_name: schemaName, url: `https://${subdomain}.${DOMAIN}` },
        api_keys: { anon: anonKey, service: serviceKey },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ step: "create_project", error: err.message });
      return apiError(reply, "GEN_002");
    } finally {
      client.release();
    }
  });
};

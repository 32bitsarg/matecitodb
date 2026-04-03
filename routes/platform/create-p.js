const {
  db,
  requirePlatformAuth,
  isWorkspaceMember,
  generateSchemaName,
  generateToken,
  createProjectSchema,
} = require("../../lib/matecito");

const DOMAIN = "matecito.dev";

/**
 * Genera un subdominio único a partir del nombre del proyecto.
 * Ej: "Recién Llegué" → "recienllegue"
 *     "Mi App 2"      → "mi-app-2"
 */
function generateSubdomain(name) {
  return name
    .toLowerCase()
    .normalize("NFD")                      // descompone acentos
    .replace(/[\u0300-\u036f]/g, "")       // elimina diacríticos (á→a, é→e)
    .replace(/[^a-z0-9\s-]/g, "")         // solo letras, números, espacios y guiones
    .trim()
    .replace(/\s+/g, "-")                  // espacios → guiones
    .replace(/-+/g, "-")                   // guiones múltiples → uno solo
    .substring(0, 50)                      // máximo 50 chars
}

/**
 * Si el subdominio ya existe, le agrega un sufijo numérico.
 * Ej: "recienllegue" → "recienllegue-2" → "recienllegue-3"
 */
async function resolveUniqueSubdomain(client, base) {
  let subdomain = base
  let attempt   = 1

  while (true) {
    const { rows } = await client.query(
      "SELECT id FROM projects WHERE subdomain = $1 LIMIT 1",
      [subdomain]
    )
    if (rows.length === 0) return subdomain

    attempt++
    subdomain = `${base}-${attempt}`
  }
}

module.exports = async function (fastify) {
  fastify.post("/create-p", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId     = req.user.id;
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const name        = String(req.body?.name        || "").trim();

    if (!workspaceId || !name) {
      return reply.code(400).send({ error: "workspaceId and name are required" });
    }

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (membership.role === "viewer") {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // 1. Generar subdominio único
      const baseSubdomain = generateSubdomain(name);
      const subdomain     = await resolveUniqueSubdomain(client, baseSubdomain);

      // 2. Crear el proyecto (con subdomain y configuración por defecto)
      const projectRes = await client.query(
        `INSERT INTO projects (workspace_id, name, subdomain, storage_quota_mb, log_retention_days, sql_enabled)
         VALUES ($1, $2, $3, 250, 30, false)
         RETURNING id, workspace_id, name, subdomain, storage_quota_mb, log_retention_days, sql_enabled, created_at`,
        [workspaceId, name, subdomain]
      );

      const project    = projectRes.rows[0];
      const schemaName = generateSchemaName(project.id);

      await client.query(
        `UPDATE projects SET schema_name = $1 WHERE id = $2`,
        [schemaName, project.id]
      );

      await createProjectSchema(client, schemaName);

      // 3. Generar API keys
      const anonKey    = `anon_${generateToken(24)}`;
      const serviceKey = `srv_${generateToken(32)}`;

      await client.query(
        `
        INSERT INTO api_keys (project_id, key, type)
        VALUES
          ($1, $2, 'anon'),
          ($1, $3, 'service')
        `,
        [project.id, anonKey, serviceKey]
      );

      await client.query("COMMIT");

      // 4. Respuesta con URL del proyecto
      return reply.code(201).send({
        project: {
          ...project,
          schema_name: schemaName,
          url: `https://${subdomain}.${DOMAIN}`,
        },
        api_keys: {
          anon:    anonKey,
          service: serviceKey,
        },
      });

    } catch (err) {
      await client.query("ROLLBACK");
      fastify.log.error(err);
      return reply.code(500).send({ error: "Could not create project" });
    } finally {
      client.release();
    }
  });
};

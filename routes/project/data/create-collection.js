const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
  getProjectKeyContext
} = require("../../../lib/matecito");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const VALID_TYPES = new Set([
  "text",
  "number",
  "boolean",
  "date",
  "json"
]);

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    try {
      const project = req.resolvedProject;
      const projectId = project?.id ?? req.params?.projectId;

      const name = String(req.body?.collection || req.body?.name || "").trim();
      const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];

      if (!name) {
        return reply.code(400).send({ error: "Name required" });
      }

      if (!SAFE_KEY.test(name)) {
        return reply.code(400).send({
          error: "Invalid collection name"
        });
      }

      // ─── schema ─────────────────────────────

      const schemaName = project?.schema_name ?? await (async () => {
        const res = await db.query(
          `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
          [projectId]
        );
        return res.rows[0]?.schema_name;
      })();

      if (!schemaName) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const schema = quoteIdent(schemaName);

      // ─── check exists ─────────────────────

      const exists = await db.query(
        `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
        [name]
      );

      if (exists.rows[0]) {
        return reply.code(409).send({ error: "Collection already exists" });
      }

      // ─── transaction ─────────────────────

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        // 1. crear colección
        await client.query(
          `INSERT INTO ${schema}._collections (name) VALUES ($1)`,
          [name]
        );

        // 2. validar fields
        const seen = new Set();

        for (const f of fields) {
          const fname = String(f.name || "").trim();
          const ftype = String(f.type || "text").trim();
          const required = Boolean(f.required);

          if (!SAFE_KEY.test(fname)) {
            throw new Error(`Invalid field name '${fname}'`);
          }

          if (!VALID_TYPES.has(ftype)) {
            throw new Error(`Invalid type '${ftype}'`);
          }

          if (seen.has(fname)) {
            throw new Error(`Duplicate field '${fname}'`);
          }

          seen.add(fname);

          await client.query(
            `INSERT INTO ${schema}._fields (collection, name, type, required)
             VALUES ($1, $2, $3, $4)`,
            [name, fname, ftype, required]
          );
        }

        // 3. timestamps automáticos (opcional pero PRO)
        await client.query(
          `INSERT INTO ${schema}._fields (collection, name, type)
           VALUES 
           ($1, 'created_at', 'date'),
           ($1, 'updated_at', 'date')`,
          [name]
        );

        // 4. permisos default (tipo Supabase)
        const operations = ["list", "get", "create", "update", "delete"];

        for (const op of operations) {
          await client.query(
            `INSERT INTO ${schema}._permissions (collection, operation, access)
             VALUES ($1, $2, 'auth')`,
            [name, op]
          );
        }

        await client.query("COMMIT");

        return reply.code(201).send({
          ok: true,
          collection: {
            name,
            fields,
          },
        });

      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

    } catch (err) {
      fastify.log.error(err);
      return reply.code(400).send({
        error: err.message || "Failed to create collection"
      });
    }
  };

  // ─── Auth flexible: JWT o service key ─────────────

  async function requireJwtOrServiceKey(req, reply) {
    const rawKey = req.headers["x-matecito-key"];
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;

    if (rawKey && projectId) {
      const ctx = await getProjectKeyContext(projectId, rawKey, ["service"]).catch(() => null);
      if (ctx) return;
    }

    return requireProjectOrPlatformAuth(req, reply);
  }

  projectRoute(
    fastify,
    "POST",
    "/collections",
    { preHandler: requireJwtOrServiceKey },
    handler
  );
};

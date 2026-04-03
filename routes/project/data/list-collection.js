const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute
} = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    try {
      const project = req.resolvedProject;
      const projectId = project?.id ?? req.params?.projectId;

      const includeRaw = String(req.query?.include || "");
      const include = new Set(
        includeRaw.split(",").map(s => s.trim()).filter(Boolean)
      );

      const withFields = include.has("fields");
      const withCounts = include.has("counts");
      const withPerms  = include.has("permissions");

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

      // ─── queries dinámicas ──────────────────

      const queries = [
        db.query(`SELECT * FROM ${schema}._collections ORDER BY created_at DESC`)
      ];

      if (withFields) {
        queries.push(
          db.query(`SELECT * FROM ${schema}._fields ORDER BY created_at ASC`)
        );
      }

      if (withCounts) {
        queries.push(
          db.query(`
            SELECT collection, COUNT(*)::int AS count
            FROM ${schema}._records
            GROUP BY collection
          `)
        );
      }

      if (withPerms) {
        queries.push(
          db.query(`SELECT * FROM ${schema}._permissions`)
        );
      }

      const results = await Promise.all(queries);

      const collectionsResult = results[0];

      let fieldsResult, countsResult, permsResult;
      let idx = 1;

      if (withFields) {
        fieldsResult = results[idx++];
      }

      if (withCounts) {
        countsResult = results[idx++];
      }

      if (withPerms) {
        permsResult = results[idx++];
      }

      // ─── mapear fields ─────────────────────

      const fieldsByCollection = {};
      if (withFields && fieldsResult) {
        for (const f of fieldsResult.rows) {
          if (!fieldsByCollection[f.collection]) {
            fieldsByCollection[f.collection] = [];
          }
          fieldsByCollection[f.collection].push(f);
        }
      }

      // ─── mapear counts ─────────────────────

      const countsByCollection = {};
      if (withCounts && countsResult) {
        for (const row of countsResult.rows) {
          countsByCollection[row.collection] = row.count;
        }
      }

      // ─── mapear permisos ───────────────────

      const permsByCollection = {};
      if (withPerms && permsResult) {
        for (const p of permsResult.rows) {
          if (!permsByCollection[p.collection]) {
            permsByCollection[p.collection] = {};
          }
          permsByCollection[p.collection][p.operation] = p.access;
        }
      }

      // ─── construir respuesta ───────────────

      const collections = collectionsResult.rows.map(col => {
        const base = {
          name: col.name,
          created_at: col.created_at,
        };

        if (withFields) {
          base.fields = fieldsByCollection[col.name] ?? [];
          base.fields_count = base.fields.length;
        }

        if (withCounts) {
          base.records_count = countsByCollection[col.name] ?? 0;
        }

        if (withPerms) {
          base.permissions = permsByCollection[col.name] ?? {};
        }

        return base;
      });

      return {
        collections,
        meta: {
          total: collections.length,
          includes: [...include],
        }
      };

    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({
        error: "Failed to fetch collections"
      });
    }
  };

  projectRoute(
    fastify,
    "GET",
    "/collections",
    { preHandler: requireProjectOrPlatformAuth },
    handler
  );
};

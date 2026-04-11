// ─── Project Branching (O1) ────────────────────────────────────────────────
//
// POST   /projects/:id/branch           → crear branch
// GET    /projects/:id/branches          → listar branches
// POST   /projects/:id/branch/diff      → diff schema
// POST   /projects/:id/branch/merge     → merge branch → prod
// DELETE /projects/:id/branches/:branchId → eliminar branch

const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

const METADATA_TABLES = [
  '_collections', '_fields', '_permissions',
  '_functions', '_triggers', '_crons',
  '_workflows', '_email_templates',
  '_webhooks', '_remote_config', '_forms',
  '_cache_rules', '_ip_rules', '_rate_limit_rules',
];

/**
 * Copia todas las tablas de metadata de un schema a otro.
 * No copia _records ni _auth_users.
 */
async function cloneSchema(client, srcSchema, dstSchema) {
  for (const table of METADATA_TABLES) {
    const srcTable = quoteIdent(srcSchema) + "." + table;
    const dstTable = quoteIdent(dstSchema) + "." + table;

    // Get columns
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [srcSchema, table]
    );
    if (!cols.length) continue;

    const colList = cols.map(c => `"${c.column_name}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

    // Fetch all rows from source
    const { rows } = await client.query(`SELECT ${colList} FROM ${srcTable}`);

    for (const row of rows) {
      const values = cols.map(c => {
        const val = row[c.column_name];
        if (val === null || val === undefined) return null;
        if (typeof val === "object") return JSON.stringify(val);
        return val;
      });

      try {
        await client.query(
          `INSERT INTO ${dstTable} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
      } catch { /* skip conflicts */ }
    }
  }
}

module.exports = async function (fastify) {
  // POST /projects/:id/branch
  fastify.post("/projects/:id/branch", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name:         { type: "string" },
          copy_schema:  { type: "boolean" },
          copy_data:    { type: "boolean" },
          copy_users:   { type: "boolean" },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params;
    const { name, copy_schema = true, copy_data = false, copy_users = false } = req.body;

    const { rows: proj } = await db.query(
      `SELECT id, name, workspace_id FROM projects WHERE id = $1`, [id]
    );
    if (!proj[0]) return apiError(reply, "GEN_003", "Project not found");

    const branchSchemaName = `${proj[0].name}_${name}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 50);

    // Create branch as a new project with the same workspace
    const { rows: newProj } = await db.query(
      `INSERT INTO projects (name, subdomain, workspace_id)
       VALUES ($1, $2, $3) RETURNING id, schema_name`,
      [`${proj[0].name} (${name})`, `${name}-${id.slice(0, 8)}`, proj[0].workspace_id]
    );

    const branchId = newProj[0].id;
    const branchSchema = newProj[0].schema_name;

    // Create schema and base tables
    const { createProjectSchema } = require("../../../../lib/matecito");
    await createProjectSchema(branchId, branchSchema);
    await ensureV2Tables(branchSchema);

    // Clone schema
    if (copy_schema) {
      const client = await db.connect();
      try {
        await cloneSchema(client, proj[0].schema_name, branchSchema);
      } finally { client.release(); }
    }

    // Clone data
    if (copy_data) {
      const client = await db.connect();
      try {
        const src = quoteIdent(proj[0].schema_name) + "._records";
        const dst = quoteIdent(branchSchema) + "._records";
        const { rows: records } = await client.query(`SELECT collection, data, expires_at, deleted_at FROM ${src}`);
        for (const r of records) {
          await client.query(
            `INSERT INTO ${dst} (collection, data, expires_at, deleted_at) VALUES ($1,$2,$3,$4)`,
            [r.collection, JSON.stringify(r.data), r.expires_at, r.deleted_at]
          ).catch(() => {});
        }
      } finally { client.release(); }
    }

    // Clone users
    if (copy_users) {
      const client = await db.connect();
      try {
        const srcAuth = quoteIdent(proj[0].schema_name) + "._auth_users";
        const dstAuth = quoteIdent(branchSchema) + "._auth_users";
        const { rows: users } = await client.query(`SELECT * FROM ${srcAuth}`);
        for (const u of users) {
          await client.query(
            `INSERT INTO ${dstAuth} (id, email, password_hash, email_verified, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [u.id, u.email, u.password_hash, u.email_verified, u.created_at]
          ).catch(() => {});
        }
      } finally { client.release(); }
    }

    return reply.code(201).send({
      branch_project_id: branchId,
      branch_schema: branchSchema,
      copy_schema,
      copy_data,
      copy_users,
    });
  });

  // GET /projects/:id/branches
  fastify.get("/projects/:id/branches", {
    preHandler: requireProjectOrPlatformAuth,
  }, async (req, reply) => {
    const { id } = req.params;
    const { rows: proj } = await db.query(`SELECT workspace_id FROM projects WHERE id = $1`, [id]);
    if (!proj[0]) return apiError(reply, "GEN_003");

    const { rows } = await db.query(
      `SELECT id, name, schema_name, created_at FROM projects WHERE workspace_id = $1 AND id != $2 ORDER BY created_at DESC`,
      [proj[0].workspace_id, id]
    );

    return { branches: rows };
  });

  // POST /projects/:id/branch/diff
  fastify.post("/projects/:id/branch/diff", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["branch_schema"],
        properties: { branch_schema: { type: "string" } },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params;
    const { branch_schema } = req.body;

    const { rows: proj } = await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [id]);
    if (!proj[0]) return apiError(reply, "GEN_003");

    const mainSchema = quoteIdent(proj[0].schema_name);
    const branchSchema = quoteIdent(branch_schema);

    // Get collections from both
    const { rows: mainCols } = await db.query(`SELECT name FROM ${mainSchema}._collections ORDER BY name`);
    const { rows: branchCols } = await db.query(`SELECT name FROM ${branchSchema}._collections ORDER BY name`);

    const mainSet = new Set(mainCols.map(c => c.name));
    const branchSet = new Set(branchCols.map(c => c.name));

    const added = [...branchSet].filter(c => !mainSet.has(c));
    const removed = [...mainSet].filter(c => !branchSet.has(c));
    const common = [...mainSet].filter(c => branchSet.has(c));

    const field_diff = [];
    for (const col of common) {
      const { rows: mainFields } = await db.query(`SELECT name, type FROM ${mainSchema}._fields WHERE collection=$1`, [col]);
      const { rows: branchFields } = await db.query(`SELECT name, type FROM ${branchSchema}._fields WHERE collection=$1`, [col]);
      const mFields = new Map(mainFields.map(f => [f.name, f.type]));
      const bFields = new Map(branchFields.map(f => [f.name, f.type]));

      for (const [name, type] of bFields) {
        if (!mFields.has(name)) field_diff.push({ collection: col, field: name, status: "added_in_branch" });
        else if (mFields.get(name) !== type) field_diff.push({ collection: col, field: name, main_type: mFields.get(name), branch_type: type });
      }
      for (const [name, type] of mFields) {
        if (!bFields.has(name)) field_diff.push({ collection: col, field: name, status: "missing_in_branch" });
      }
    }

    return {
      main_schema: proj[0].schema_name,
      branch_schema,
      collections: { added, removed, common: common.length },
      field_diff,
    };
  });

  // POST /projects/:id/branch/merge
  fastify.post("/projects/:id/branch/merge", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["branch_schema"],
        properties: {
          branch_schema: { type: "string" },
          collections:   { type: "array" },  // specific collections to merge, or all
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params;
    const { branch_schema, collections } = req.body;

    const { rows: proj } = await db.query(`SELECT schema_name FROM projects WHERE id = $1`, [id]);
    if (!proj[0]) return apiError(reply, "GEN_003");

    const mainSchema = quoteIdent(proj[0].schema_name);
    const client = await db.connect();
    let merged = 0;

    try {
      await client.query("BEGIN");

      // Get branch collections
      const branchSchemaQ = quoteIdent(branch_schema);
      const { rows: bCols } = await client.query(
        `SELECT name FROM ${branchSchemaQ}._collections ${collections?.length ? `WHERE name = ANY($1)` : ""}`,
        collections ? [collections] : []
      );

      for (const col of bCols) {
        // Create collection in main if not exists
        const { rows: exists } = await client.query(
          `SELECT 1 FROM ${mainSchema}._collections WHERE name = $1`, [col.name]
        );

        if (!exists[0]) {
          // Copy collection
          const { rows: colData } = await client.query(
            `SELECT soft_delete, permissions FROM ${branchSchemaQ}._collections WHERE name = $1`, [col.name]
          );
          if (colData[0]) {
            await client.query(
              `INSERT INTO ${mainSchema}._collections (name, soft_delete, permissions) VALUES ($1,$2,$3)`,
              [col.name, colData[0].soft_delete, JSON.stringify(colData[0].permissions || {})]
            );
          }

          // Copy fields
          const { rows: fields } = await client.query(
            `SELECT name, type, required, options, constraints FROM ${branchSchemaQ}._fields WHERE collection = $1`,
            [col.name]
          );
          for (const f of fields) {
            await client.query(
              `INSERT INTO ${mainSchema}._fields (collection, name, type, required, options, constraints) VALUES ($1,$2,$3,$4,$5,$6)`,
              [col.name, f.name, f.type, f.required, f.options ? JSON.stringify(f.options) : null, f.constraints ? JSON.stringify(f.constraints) : null]
            );
          }

          // Copy permissions
          const { rows: perms } = await client.query(
            `SELECT operation, access_level, filter_rule FROM ${branchSchemaQ}._permissions WHERE collection = $1`,
            [col.name]
          );
          for (const p of perms) {
            await client.query(
              `INSERT INTO ${mainSchema}._permissions (collection, operation, access_level, filter_rule) VALUES ($1,$2,$3,$4)`,
              [col.name, p.operation, p.access_level, p.filter_rule]
            );
          }

          merged++;
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }

    return { merged_collections: merged };
  });

  // DELETE /projects/:id/branches/:branchId
  fastify.delete("/projects/:id/branches/:branchId", {
    preHandler: requireProjectOrPlatformAuth,
  }, async (req, reply) => {
    const { id, branchId } = req.params;

    const { rows: branchProj } = await db.query(
      `SELECT id, schema_name FROM projects WHERE id = $1 AND workspace_id = (SELECT workspace_id FROM projects WHERE id = $2)`,
      [branchId, id]
    );
    if (!branchProj[0]) return apiError(reply, "GEN_003", "Branch not found");

    // Drop schema
    await db.query(`DROP SCHEMA IF EXISTS ${quoteIdent(branchProj[0].schema_name)} CASCADE`);
    await db.query(`DELETE FROM projects WHERE id = $1`, [branchId]);

    return { deleted: branchId };
  });
};

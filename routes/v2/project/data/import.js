const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 }  = require("../../../../lib/v2/permissions");
const { validateRecordData } = require("../../../../lib/v2/field-validator");
const { emitProjectEvent }   = require("../../../../lib/v2/realtime");
const { apiError }           = require("../../../../lib/v2/errors");

const MAX_ROWS   = 5_000;
const CHUNK_SIZE = 500;

function parseCSV(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));

  return lines.slice(1).map(line => {
    // Simple CSV parser: handle quoted fields
    const cells = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cells.push(current); current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);

    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = cells[i]?.trim() ?? null; });
    return obj;
  });
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, on_conflict = "skip" } = req.query;
    if (!collection) return reply.code(400).send({ error: "collection query param is required", code: "GEN_002" });
    if (!["skip", "update"].includes(on_conflict)) {
      return reply.code(400).send({ error: "on_conflict must be 'skip' or 'update'", code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "create", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);

    const colExists = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [collection]
    );
    if (!colExists.rows[0]) return apiError(reply, "GEN_003", `Collection '${collection}' not found`);

    // ── Parse body ──────────────────────────────────────────────────────────
    let rows = [];
    const contentType = req.headers["content-type"] ?? "";

    if (contentType.includes("text/csv")) {
      const text = typeof req.body === "string" ? req.body : req.body?.toString?.() ?? "";
      rows = parseCSV(text);
    } else {
      // JSON: accept { records: [...] } or bare array
      const body = req.body;
      if (Array.isArray(body)) rows = body;
      else if (Array.isArray(body?.records)) rows = body.records;
      else return reply.code(400).send({ error: "Body must be an array or { records: [...] }", code: "GEN_002" });
    }

    if (rows.length === 0) return reply.code(400).send({ error: "No rows to import", code: "GEN_002" });
    if (rows.length > MAX_ROWS) return reply.code(400).send({ error: `Maximum ${MAX_ROWS} rows per import`, code: "GEN_002" });

    // ── Process in chunks ───────────────────────────────────────────────────
    let inserted = 0;
    let skipped  = 0;
    const errors = [];

    for (let chunkStart = 0; chunkStart < rows.length; chunkStart += CHUNK_SIZE) {
      const chunk  = rows.slice(chunkStart, chunkStart + CHUNK_SIZE);
      const client = await db.connect();

      try {
        await client.query("BEGIN");

        for (let i = 0; i < chunk.length; i++) {
          const rowIndex = chunkStart + i;
          const rawData  = chunk[i];

          if (!rawData || typeof rawData !== "object") {
            errors.push({ row: rowIndex, reason: "Row is not a valid object" });
            continue;
          }

          // Validate
          const ve = await validateRecordData(schemaName, collection, rawData);
          if (ve) {
            errors.push({ row: rowIndex, field: ve.field, reason: ve.message });
            continue;
          }

          if (on_conflict === "update") {
            await client.query(
              `INSERT INTO ${schema}._records (collection, data)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [collection, rawData]
            );
          } else {
            await client.query(
              `INSERT INTO ${schema}._records (collection, data) VALUES ($1, $2)`,
              [collection, rawData]
            );
          }
          inserted++;
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        // Mark entire chunk as failed
        for (let i = 0; i < chunk.length; i++) {
          errors.push({ row: chunkStart + i, reason: err.message });
        }
        inserted -= Math.min(CHUNK_SIZE, chunk.length); // adjust (rough)
      } finally {
        client.release();
      }
    }

    skipped = rows.length - inserted - errors.length;

    emitProjectEvent(projectId, { type: "records.imported", projectId, collection, count: inserted }).catch(() => {});

    return reply.code(201).send({
      ok:       true,
      inserted,
      skipped,
      failed:   errors.length,
      errors:   errors.slice(0, 100), // cap error list
    });
  };

  projectRoute(fastify, "POST", "/records/import", {
    preHandler: flexAuth,
    config: {
      rateLimit:       { max: 5, timeWindow: "10 minutes" },
      rawBody:         true,
    },
  }, handler);
};

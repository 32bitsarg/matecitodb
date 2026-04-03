const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const MAX_EXPORT_ROWS = 10_000;

function toCSV(rows) {
  if (rows.length === 0) return "";

  // Recolectar todas las claves de data + columnas fijas
  const dataKeys = new Set();
  for (const row of rows) {
    if (row.data && typeof row.data === "object") {
      Object.keys(row.data).forEach(k => dataKeys.add(k));
    }
  }

  const fixedCols = ["id", "collection", "created_at", "updated_at", "expires_at"];
  const dataCols  = [...dataKeys].sort();
  const allCols   = [...fixedCols, ...dataCols];

  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [allCols.join(",")];
  for (const row of rows) {
    const cells = fixedCols.map(c => escape(row[c]));
    for (const k of dataCols) cells.push(escape(row.data?.[k]));
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, format = "json", include_expired } = req.query;

    if (!collection) {
      return reply.code(400).send({ error: "collection is required" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    if (!(await checkPermission(schemaName, collection, "list", req, reply))) return;

    const schema = quoteIdent(schemaName);

    const expiredFilter = include_expired === "true"
      ? ""
      : "AND (expires_at IS NULL OR expires_at > NOW())";

    const { rows } = await db.query(
      `SELECT * FROM ${schema}._records
       WHERE collection = $1 ${expiredFilter}
       ORDER BY created_at ASC
       LIMIT $2`,
      [collection, MAX_EXPORT_ROWS]
    );

    const fmt = format === "csv" ? "csv" : "json";

    if (fmt === "csv") {
      const csv = toCSV(rows);
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${collection}.csv"`)
        .send(csv);
      return;
    }

    // JSON
    reply
      .header("Content-Type", "application/json")
      .header("Content-Disposition", `attachment; filename="${collection}.json"`)
      .send(JSON.stringify({ collection, count: rows.length, records: rows }, null, 2));
  };

  projectRoute(fastify, "GET", "/records/export", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, handler);
};

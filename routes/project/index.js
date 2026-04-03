const fs = require("fs");
const path = require("path");

module.exports = async function (fastify) {
  // Log buffering is handled globally in index.js via bufferLog + flushLogs.

  // ─── Auto-load all route files ────────────────────────────
  function load(dir) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === "index.js" || entry.startsWith("_")) continue;

      const full = path.join(dir, entry);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        load(full);
      } else if (entry.endsWith(".js")) {
        fastify.register(require(full));
      }
    }
  }

  load(__dirname);
};


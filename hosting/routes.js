const fs = require("fs");
const path = require("path");

module.exports = async function (fastify) {
  const dir = path.join(__dirname, "routes");
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".js")) continue;
    fastify.register(require(path.join(dir, entry)));
  }
};

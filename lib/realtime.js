const { EventEmitter } = require("events");

const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(0);

function emitProjectEvent(projectId, event) {
  realtimeBus.emit(`project:${projectId}`, event);
}

module.exports = {
  realtimeBus,
  emitProjectEvent,
};

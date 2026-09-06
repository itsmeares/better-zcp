// Disposable harness for dbShutdownRaceIntegration.test.js -- reproduces
// index.js's REAL post-fix shutdown shape (two independent SIGTERM/SIGINT
// listeners: this file's own explicit flushForShutdown() call, and
// database/init.js's own registerShutdownHandlers(), both firing on the
// same signal, unsynchronized) using the actual, unmocked database/init.js
// module. Not the real apps/panel-server/index.js on purpose -- booting the full app
// (server discovery, RCON, etc.) would test a pile of unrelated subsystems
// to answer a question that's entirely about signal-handler sequencing and
// flushForShutdown()'s own bound. Prints single-line stdout markers the
// parent test greps for instead of a real readiness endpoint.
import http from "node:http";
import { initDatabase, setSetting, flushForShutdown } from "../../database/init.js";

let isShuttingDown = false;
const httpServer = http.createServer((req, res) => res.end("ok"));

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HARNESS: ${signal} received`);
  // The fix under test: an explicit, awaited flush before closing up --
  // mirrors the new line in apps/panel-server/index.js's gracefulShutdown().
  await flushForShutdown();
  console.log("HARNESS: flushForShutdown settled");
  httpServer.close(() => {
    console.log("HARNESS: http closed, exiting");
    process.exit(0);
  });
  setTimeout(() => {
    console.log("HARNESS: force-exit timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

(async () => {
  // initDatabase() -> getDb() also registers database/init.js's OWN,
  // separate SIGTERM/SIGINT/beforeExit listener (registerShutdownHandlers)
  // -- this is the second, unsynchronized listener the real bug is about.
  await initDatabase();
  await setSetting("shutdownRaceProbe", String(Date.now()));
  httpServer.listen(0, () => {
    console.log(`HARNESS: listening ${httpServer.address().port}`);
  });
})();

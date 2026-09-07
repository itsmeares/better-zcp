import http from "node:http";
import { initDatabase, setSetting, flushForShutdown } from "../../database/init.ts";

let isShuttingDown = false;
const httpServer = http.createServer((req, res) => res.end("ok"));

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`HARNESS: ${signal} received`);
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
  await initDatabase();
  await setSetting("shutdownRaceProbe", String(Date.now()));
  httpServer.listen(0, () => {
    console.log(`HARNESS: listening ${httpServer.address().port}`);
  });
})();

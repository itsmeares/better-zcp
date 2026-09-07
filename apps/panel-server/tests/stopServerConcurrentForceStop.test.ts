import { describe, expect, it } from "vitest";
import { ServerManager } from "../services/serverManager.ts";


function makeManager(overrides = {}) {
  const manager = new ServerManager();
  Object.assign(
    manager,
    { configLoaded: true, serverName: "ConcurrentStopTest" },
    overrides,
  );
  return manager;
}

describe("stopServer(): a second concurrent call (a second Force Stop) is refused, matching startServer()'s existing guard", () => {
  it("only the first call scans and kills; the second is refused immediately with a visible message, not raced", async () => {
    const manager = makeManager();
    let killCalls = [];
    let processKilled = false;

    manager.getServerProcessDetails = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        running: !processKilled,
        matched: [{ pid: "9999", cmd: "java zombie.network.GameServer -servername ConcurrentStopTest" }],
        owned: [{ pid: "9999", cmd: "java zombie.network.GameServer -servername ConcurrentStopTest" }],
        scanFailed: false,
      };
    };
    manager._killPids = async (pids) => {
      killCalls.push(pids.slice());
      await new Promise((r) => setTimeout(r, 5));
      processKilled = true;
      return { timedOut: false, failed: false, errors: [] };
    };

    const [resultA, resultB] = await Promise.all([
      manager.stopServer(false),
      manager.stopServer(false),
    ]);

    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).toEqual(["9999"]);

    const results = [resultA, resultB];
    const succeeded = results.filter((r) => r.success);
    const refused = results.filter((r) => !r.success);
    expect(succeeded.length).toBe(1);
    expect(refused.length).toBe(1);
    expect(refused[0].message).toMatch(/already in progress/i);
    expect(refused[0].error).toBe("Stop already in progress");

    expect(manager._stopping).toBe(false);
  });

  it("contrast: startServer() DOES refuse a concurrent call outright -- the asymmetry Dashboard.tsx's comment describes is real", async () => {
    const manager = makeManager();
    manager._stopping = true;

    await expect(manager.startServer({ skipRunningCheck: true })).rejects.toThrow(
      /stop in progress/i,
    );
  });
});

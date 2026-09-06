import { afterEach, describe, expect, it, vi } from "vitest";

// Phase 1 finding (Oscar, 2026-08-29): scheduler.performRestart() calls
// runManagedLifecycle()/serverManager.stopServer()/startServer() directly,
// bypassing apps/panel-server/routes/server.js entirely -- so NONE of the server:status
// pushes that route already makes for a plain /start or /stop ever fired
// during a restart's stop-then-start sequence, which the surrounding sleeps
// show can run 60+ real seconds. The only client-visible event during the
// whole restart used to be one terminal scheduler:action_result once
// performRestart() resolved completely.
//
// Fixed: performRestart() now pushes server:status itself at its own two
// VERIFIED transition points (old process confirmed stopped; new instance
// confirmed started), via a new Scheduler.setIo()/_emitVerifiedTransition()
// -- see scheduler.js's own comments for why this is safe alongside the
// index.js status watchdog rather than a second, racing emitter.

const getServer = vi.fn();
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { Scheduler } = await import("../services/scheduler.js");

function makeRconService(overrides = {}) {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

describe("performRestart() pushes server:status at its own verified transitions", () => {
  afterEach(() => {
    getServer.mockReset();
    getActiveServer.mockReset();
    runManagedLifecycle.mockReset();
  });

  it("native restart: emits {running:false} once the old process is confirmed stopped, then {running:true} once the new one is confirmed up", async () => {
    // No serverName on either lookup -- keeps _backupConfigBeforeRestart()
    // and refreshLaunchTargetBeforeStart() harmless no-ops (see their own
    // early-return guards) instead of needing a real filesystem fixture,
    // which is irrelevant to what this test is checking.
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: false });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {}; // no real countdown/poll delays in a test
    scheduler.setIo({ emit });

    const rconService = makeRconService();
    // First call (initial wasRunning check) reports running; every call
    // after that (inside the "wait for the old process to actually exit"
    // loop) reports it gone, so that loop exits on its very first check.
    const getServerProcessDetails = vi
      .fn()
      .mockResolvedValueOnce({ running: true, scanFailed: false })
      .mockResolvedValue({ running: false, scanFailed: false });
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails,
      startServer: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    const calls = emit.mock.calls.filter(([event]) => event === "server:status");
    expect(calls).toEqual([
      ["server:status", { running: false }],
      ["server:status", { running: true }],
    ]);
  });

  it("Docker-managed restart: emits only {running:true} -- there is no separately-observable stopped moment (docker restart is atomic)", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    scheduler.setIo({ emit });

    const rconService = makeRconService();
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    };

    const result = await scheduler.performRestart(0, { rconService, serverManager });

    expect(result.success).toBe(true);
    const calls = emit.mock.calls.filter(([event]) => event === "server:status");
    expect(calls).toEqual([["server:status", { running: true }]]);
  });

  it("does not throw when no io has been wired (setIo never called)", async () => {
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    // Deliberately no scheduler.setIo(...) call.

    const rconService = makeRconService();
    const serverManager = {
      _serverId: 1,
      getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    };

    await expect(
      scheduler.performRestart(0, { rconService, serverManager }),
    ).resolves.toMatchObject({ success: true });
  });
});

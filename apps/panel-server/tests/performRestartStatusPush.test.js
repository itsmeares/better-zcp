import { afterEach, describe, expect, it, vi } from "vitest";


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
vi.mock("../services/managedContainer.ts", () => ({
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
    getServer.mockResolvedValue(null);
    getActiveServer.mockResolvedValue(null);
    runManagedLifecycle.mockResolvedValue({ handled: false });

    const emit = vi.fn();
    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};
    scheduler.setIo({ emit });

    const rconService = makeRconService();
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

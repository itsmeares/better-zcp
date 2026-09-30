import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const getTrackedMods = vi.fn(async () => []);
const updateModTimestamp = vi.fn();
const logServerEvent = vi.fn();
const getSetting = vi.fn(async (key) =>
  key === "modAutoRestartEnabled" ? true : null,
);
const setSetting = vi.fn();
const addTrackedMod = vi.fn();
const getCurrentServer = vi.fn(async () => null);
const isModIgnored = vi.fn(async () => false);
const markModsChecked = vi.fn();

vi.mock("../database/init.ts", () => ({
  getTrackedMods,
  updateModTimestamp,
  logServerEvent,
  getSetting,
  setSetting,
  addTrackedMod,
  getCurrentServer,
  isModIgnored,
  markModsChecked,
}));

const { ModChecker } = await import("../services/modChecker.ts");

describe("ModChecker.init(): restored auto-restart callback propagates handleModUpdate's result", () => {
  beforeEach(() => {
    getSetting.mockClear();
    getTrackedMods.mockClear();
    getCurrentServer.mockClear();
  });

  it("returns handleModUpdate's result instead of resolving undefined", async () => {
    const checker = new ModChecker();
    checker.handleModUpdate = vi.fn(async () => ({
      success: true,
      markProcessed: true,
      reason: "restart_complete",
    }));

    await checker.init({ scheduleTask: vi.fn() });

    expect(typeof checker.onUpdateCallback).toBe("function");
    const result = await checker.onUpdateCallback([{ workshopId: "123" }]);

    expect(checker.handleModUpdate).toHaveBeenCalledWith([{ workshopId: "123" }]);
    expect(result).toEqual({
      success: true,
      markProcessed: true,
      reason: "restart_complete",
    });
  });

  it("still logs a warning on a failed handleModUpdate while returning its result", async () => {
    const checker = new ModChecker();
    checker.handleModUpdate = vi.fn(async () => ({
      success: false,
      error: "RCON disconnected",
    }));

    await checker.init({ scheduleTask: vi.fn() });
    const result = await checker.onUpdateCallback([{ workshopId: "456" }]);

    expect(result).toEqual({ success: false, error: "RCON disconnected" });
  });
  it("leaves deferred Workshop updates eligible and only marks a completed restart processed", async () => {
    const checker = new ModChecker(), run = vi.fn();
    checker.scheduler = { maintenance: { run } };
    const updates = [{ workshopId: "123", latestTimestamp: new Date(123456) }];
    run.mockResolvedValueOnce({ success: false, deferred: true });
    await checker.triggerModRestart(updates); expect(checker.processedUpdates.has("123")).toBe(false);
    run.mockResolvedValueOnce({ success: true });
    await checker.triggerModRestart(updates); expect(checker.processedUpdates.get("123")).toBe(123456);
  });

});

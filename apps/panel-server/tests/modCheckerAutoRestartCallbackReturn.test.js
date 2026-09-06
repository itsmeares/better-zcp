import { beforeEach, describe, expect, it, vi } from "vitest";

const getTrackedMods = vi.fn(async () => []);
const updateModTimestamp = vi.fn();
const logServerEvent = vi.fn();
const getSetting = vi.fn(async (key) =>
  key === "modAutoRestartEnabled" ? true : null,
);
const setSetting = vi.fn();
const addTrackedMod = vi.fn();
const getActiveServer = vi.fn(async () => null);
const isModIgnored = vi.fn(async () => false);
const markModsChecked = vi.fn();

vi.mock("../database/init.js", () => ({
  getTrackedMods,
  updateModTimestamp,
  logServerEvent,
  getSetting,
  setSetting,
  addTrackedMod,
  getActiveServer,
  isModIgnored,
  markModsChecked,
}));

const { ModChecker } = await import("../services/modChecker.js");

// Regression (2026-08-31 services sweep): init()'s restored auto-restart
// callback was block-bodied and never returned handleModUpdate()'s result,
// so checkForUpdates()'s `callbackResult?.markProcessed === true` dedup
// check always saw undefined for a normal (non-player-delayed) restart --
// the same update could retrigger another restart on the next check cycle.
// routes/config.js's bulk-save callback (an implicit-return arrow) was the
// one call site that already got this right.
describe("ModChecker.init(): restored auto-restart callback propagates handleModUpdate's result", () => {
  beforeEach(() => {
    getSetting.mockClear();
    getTrackedMods.mockClear();
    getActiveServer.mockClear();
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
});

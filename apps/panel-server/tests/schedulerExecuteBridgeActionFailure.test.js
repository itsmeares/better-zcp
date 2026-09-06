import { afterEach, describe, expect, it, vi } from "vitest";

// bug-hunt-2026-08-27 (hunt: scheduler execution path, not validation):
// Scheduler.executeBridgeAction() used to end with
//   const result = await panelBridge.sendCommand(action, args);
//   if (result && result.success === false) throw new Error(...);
//   return result;
// That `if` was dead code. panelBridge.js's processResult() (the only place
// a pending sendCommand() promise ever settles) has exactly two outcomes:
// pending.resolve({ success: true, data }) on success, or pending.reject(new
// Error(...)) on failure -- it never resolves an explicit
// { success: false }. So the removed branch could never fire through this
// path; the real failure signal was always the promise rejecting, which
// this function already let propagate via `await` with no try/catch of its
// own. No existing test called the real executeBridgeAction() with a
// mocked panelBridge.sendCommand (schedulerRunTask.test.js always stubs
// executeBridgeAction itself out entirely), so this dead branch had zero
// coverage in either direction -- this file adds it, exercising the real
// function against the two shapes sendCommand can actually produce.
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: vi.fn().mockResolvedValue(null),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { default: panelBridge } = await import("../services/panelBridge.js");

function makeScheduler() {
  const rconService = { connected: true };
  const serverManager = { _serverId: null };
  return new Scheduler(rconService, serverManager);
}

describe("Scheduler.executeBridgeAction() against the real panelBridge.sendCommand contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with the real success shape sendCommand actually produces ({success: true, data})", async () => {
    const sendCommand = vi
      .spyOn(panelBridge, "sendCommand")
      .mockResolvedValue({ success: true, data: { ok: true } });

    const scheduler = makeScheduler();
    const result = await scheduler.executeBridgeAction("bridge:triggerStorm");

    expect(sendCommand).toHaveBeenCalledWith("triggerStorm", {});
    expect(result).toEqual({ success: true, data: { ok: true } });
  });

  it("propagates a rejection as a thrown error -- the real (only) failure signal, not a returned {success: false}", async () => {
    vi.spyOn(panelBridge, "sendCommand").mockRejectedValue(
      new Error("Mod is not responding"),
    );

    const scheduler = makeScheduler();

    await expect(
      scheduler.executeBridgeAction("bridge:triggerStorm"),
    ).rejects.toThrow("Mod is not responding");
  });
});

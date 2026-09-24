import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../database/init.ts", () => ({
  getScheduledTasks: vi.fn(),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: vi.fn().mockResolvedValue(null),
}));

const { Scheduler } = await import("../services/scheduler.ts");
const { default: panelBridge } = await import("../services/panelBridge.ts");

function makeScheduler() {
  const rconService = { connected: true };
  const serverManager = { _serverId: null };
  return new Scheduler(rconService, serverManager);
}

describe("Scheduler.executeBridgeAction() against the real panelBridge.sendCommand contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a saved weather task without scheduling or dispatching it", async () => {
    const sendCommand = vi.spyOn(panelBridge, "sendCommand");
    const scheduler = makeScheduler();
    expect(scheduler.scheduleTask({
      id: 9, name: "Old weather task", command: "bridge:triggerStorm",
      cron_expression: "0 * * * *", enabled: 1, server_id: null,
    })).toBe(false);
    await expect(scheduler.executeBridgeAction("bridge:triggerStorm"))
      .rejects.toThrow("not allowed in scheduled tasks");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("resolves with the real success shape sendCommand actually produces ({success: true, data})", async () => {
    const sendCommand = vi
      .spyOn(panelBridge, "sendCommand")
      .mockResolvedValue({ success: true, data: { ok: true } });

    const scheduler = makeScheduler();
    const result = await scheduler.executeBridgeAction("bridge:saveWorld");

    expect(sendCommand).toHaveBeenCalledWith("saveWorld", {});
    expect(result).toEqual({ success: true, data: { ok: true } });
  });

  it("propagates a rejection as a thrown error -- the real (only) failure signal, not a returned {success: false}", async () => {
    vi.spyOn(panelBridge, "sendCommand").mockRejectedValue(
      new Error("Mod is not responding"),
    );

    const scheduler = makeScheduler();

    await expect(
      scheduler.executeBridgeAction("bridge:saveWorld"),
    ).rejects.toThrow("Mod is not responding");
  });
});

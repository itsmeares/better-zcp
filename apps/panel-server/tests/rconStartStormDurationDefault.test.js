import { describe, it, expect, vi } from "vitest";
import { RconService } from "../services/rcon.js";

describe("RconService.startStorm(): explicit duration on both paths", () => {
  function makeService() {
    const service = new RconService();
    service.execute = vi.fn(async (command) => ({ success: true, response: command }));
    return service;
  }

  it("sends an explicit 2.0-hour duration when none is given -- matches PanelBridge's Lua default exactly, not a bare command relying on PZ's own hidden default", async () => {
    const service = makeService();
    await service.startStorm();
    expect(service.execute).toHaveBeenCalledWith("startstorm 2");
  });

  it("still sends the explicit 2.0-hour default when duration is explicitly undefined", async () => {
    const service = makeService();
    await service.startStorm(undefined);
    expect(service.execute).toHaveBeenCalledWith("startstorm 2");
  });

  it("still sends the explicit 2.0-hour default when duration is explicitly null", async () => {
    const service = makeService();
    await service.startStorm(null);
    expect(service.execute).toHaveBeenCalledWith("startstorm 2");
  });

  it("passes through a caller-supplied duration unchanged", async () => {
    const service = makeService();
    await service.startStorm(5);
    expect(service.execute).toHaveBeenCalledWith("startstorm 5");
  });

  it("still rejects an out-of-range duration -- the default fix must not loosen existing validation", async () => {
    const service = makeService();
    await expect(service.startStorm(200)).rejects.toThrow("duration must be 0-168");
    await expect(service.startStorm(-1)).rejects.toThrow("duration must be 0-168");
    expect(service.execute).not.toHaveBeenCalled();
  });
});

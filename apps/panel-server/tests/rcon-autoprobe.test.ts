import { describe, expect, it, vi } from "vitest";
import { probeRconFallbackIfConfigured } from "../index.ts";


function makeFakeRconService({ portOpen = true, connectSucceeds = true } = {}) {
  return {
    config: { host: "127.0.0.1", port: 27015 },
    connected: false,
    loadConfig: vi.fn(async () => {}),
    checkPortOpen: vi.fn(async () => portOpen),
    connect: vi.fn(async function () {
      this.connected = connectSucceeds;
      return connectSucceeds;
    }),
  };
}

describe("probeRconFallbackIfConfigured", () => {
  it("makes zero RCON attempts when no server has ever been configured", async () => {
    const rcon = makeFakeRconService();

    const result = await probeRconFallbackIfConfigured(
       null,
      rcon,
      5000,
    );

    expect(result).toBe(false);
    expect(rcon.loadConfig).not.toHaveBeenCalled();
    expect(rcon.checkPortOpen).not.toHaveBeenCalled();
    expect(rcon.connect).not.toHaveBeenCalled();
  });

  it("still probes when a server IS configured but process detection missed it (WinGSM case)", async () => {
    const rcon = makeFakeRconService({ portOpen: true, connectSucceeds: true });
    const activeServer = {
      id: "srv-1",
      name: "My WinGSM Server",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "correct-horse",
    };

    const result = await probeRconFallbackIfConfigured(
      activeServer,
      rcon,
      5000,
    );

    expect(result).toBe(true);
    expect(rcon.loadConfig).toHaveBeenCalledTimes(1);
    expect(rcon.checkPortOpen).toHaveBeenCalledWith("127.0.0.1", 27015);
    expect(rcon.connect).toHaveBeenCalledTimes(1);
    expect(rcon.connected).toBe(true);
  });

  it("configured but the port isn't actually open: reports unoccupied without attempting connect", async () => {
    const rcon = makeFakeRconService({ portOpen: false });
    const activeServer = { id: "srv-2", rconPassword: "pw" };

    const result = await probeRconFallbackIfConfigured(
      activeServer,
      rcon,
      5000,
    );

    expect(result).toBe(false);
    expect(rcon.checkPortOpen).toHaveBeenCalledTimes(1);
    expect(rcon.connect).not.toHaveBeenCalled();
  });
});

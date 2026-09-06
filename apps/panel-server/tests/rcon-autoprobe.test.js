import { describe, expect, it, vi } from "vitest";
import { probeRconFallbackIfConfigured } from "../index.js";

// Regression coverage for the startup RCON fallback probe (apps/panel-server/index.js,
// inside start()'s "PZ server not detected running" branch). The probe exists
// for wrapper setups (WinGSM etc.) where process detection misses a server
// whose RCON is genuinely up. The defect: it used to fire even when no server
// had ever been configured, falling back to the hardcoded default host/port
// with an empty password — which meant a brand-new, unconfigured install
// would repeatedly try to authenticate against whatever unrelated process
// happened to be listening on the default RCON port.
//
// Both directions matter. A test that only proves "unconfigured -> no probe"
// would pass just as happily if the whole feature had been deleted, so the
// second case (configured server, process check failed, probe must still
// run) is the one that actually protects the WinGSM use case.

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
      /* activeServer */ null,
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

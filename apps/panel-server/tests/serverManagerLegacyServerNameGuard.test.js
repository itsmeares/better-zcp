import { beforeEach, describe, expect, it, vi } from "vitest";

const logServerEvent = vi.fn();
const getSetting = vi.fn();
const setSetting = vi.fn();
const getActiveServer = vi.fn();
const getServer = vi.fn();
const getServers = vi.fn();

vi.mock("../database/init.js", () => ({
  logServerEvent,
  getSetting,
  setSetting,
  getActiveServer,
  getServer,
  getServers,
}));

const { ServerManager } = await import("../services/serverManager.js");

// 2026-08-26 bug hunt finding 1: legacy settings.serverName reached
// serverManager.js's this.serverName / this.serverBat with no validation at
// all, and both are interpolated straight into a filesystem path
// (getServerConfig/saveServerConfig's `${serverName}.ini`) and a launched
// script filename (StartServer_<name>.bat / start-server_<name>.sh). The
// real fix is at the write side (config.js's PUT /app-settings now rejects
// an unsafe serverName before it can be stored, see appSettingsRoute.test.js)
// -- this pins the sink-side defense in depth for an install that already
// has a bad value saved from before that validation existed.
describe("ServerManager loadConfig -- legacy settings.serverName path-traversal guard", () => {
  beforeEach(() => {
    logServerEvent.mockReset();
    getSetting.mockReset();
    setSetting.mockReset();
    getActiveServer.mockReset();
    getServer.mockReset();
    getServers.mockReset();
    // No server profile row at all -- the precondition that actually
    // reaches the legacy-settings fallback branch this guard lives in.
    getActiveServer.mockResolvedValue(null);
  });

  function stubLegacySettings(overrides = {}) {
    const values = {
      serverPath: "/data/pz-server",
      serverName: null,
      zomboidDataPath: "/data/zomboid",
      rconHost: null,
      rconPort: null,
      ...overrides,
    };
    getSetting.mockImplementation(async (key) => values[key] ?? null);
  }

  it("ignores a legacy serverName containing a path-traversal segment instead of using it", async () => {
    stubLegacySettings({ serverName: "../../../etc/evil" });
    const manager = new ServerManager();

    await manager.loadConfig();

    // path.basename("../../../etc/evil") === "evil" !== the raw value, so
    // this must be treated as no legacy name configured at all -- not
    // silently truncated to "evil" either, which would just as silently
    // point the panel at a DIFFERENT, wrong .ini file.
    expect(manager.serverName).not.toBe("../../../etc/evil");
    expect(manager.serverName).toBeFalsy();
  });

  it("ignores a legacy serverName that is itself an absolute path", async () => {
    stubLegacySettings({ serverName: "/etc/passwd" });
    const manager = new ServerManager();

    await manager.loadConfig();

    expect(manager.serverName).not.toBe("/etc/passwd");
    expect(manager.serverName).toBeFalsy();
  });

  it("still loads a normal legacy serverName unchanged", async () => {
    stubLegacySettings({ serverName: "DoomerZ" });
    const manager = new ServerManager();

    await manager.loadConfig();

    expect(manager.serverName).toBe("DoomerZ");
    expect(manager.serverBat).toContain("DoomerZ");
  });

  it("does not let a rejected legacy serverName carry into the launched startup script filename either", async () => {
    stubLegacySettings({ serverName: "../../../evil" });
    const manager = new ServerManager();
    const priorBat = manager.serverBat;

    await manager.loadConfig();

    expect(manager.serverBat).not.toContain("../");
    expect(manager.serverBat).toBe(priorBat);
  });
});

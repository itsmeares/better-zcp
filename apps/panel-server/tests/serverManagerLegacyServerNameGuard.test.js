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

const { ServerManager } = await import("../services/serverManager.ts");

describe("ServerManager loadConfig -- legacy settings.serverName path-traversal guard", () => {
  beforeEach(() => {
    logServerEvent.mockReset();
    getSetting.mockReset();
    setSetting.mockReset();
    getActiveServer.mockReset();
    getServer.mockReset();
    getServers.mockReset();
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

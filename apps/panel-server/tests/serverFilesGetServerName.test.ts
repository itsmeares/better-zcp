import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import path from "path";

const getCurrentServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.ts", () => ({
  getCurrentServer,
  getAllSettings,
}));

const {
  getServerName,
  getServerConfigPath,
  ServerNotConfiguredError,
  parseIni,
  toIni,
} = await import("../routes/serverFiles.ts");

describe("getServerName (Finding 2: path traversal via serverName)", () => {
  beforeEach(() => {
    getCurrentServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
  });

  it("returns the active server's serverName unchanged when it is safe", async () => {
    getCurrentServer.mockResolvedValue({ serverName: "MyServer" });
    await expect(getServerName()).resolves.toBe("MyServer");
  });

  it("throws instead of returning a traversal payload from the active server", async () => {
    getCurrentServer.mockResolvedValue({ serverName: "../../etc/passwd" });
    await expect(getServerName()).rejects.toThrow(/invalid path characters/i);
  });

  it("throws instead of returning a traversal payload from legacy settings", async () => {
    getCurrentServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverName: "../../secrets" });
    await expect(getServerName()).rejects.toThrow(/invalid path characters/i);
  });

  it("falls back to legacy settings.serverName when there is no active server", async () => {
    getCurrentServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverName: "LegacyServer" });
    await expect(getServerName()).resolves.toBe("LegacyServer");
  });

  it("does not take the legacy name when an active server has none", async () => {
    getCurrentServer.mockResolvedValue({ id: "2" });
    getAllSettings.mockResolvedValue({ serverName: "OldServer" });
    await expect(getServerName()).rejects.toThrow(ServerNotConfiguredError);
  });

  it("throws ServerNotConfiguredError instead of inventing 'servertest' when nothing is configured", async () => {
    getCurrentServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerName()).rejects.toThrow(ServerNotConfiguredError);
  });
});

describe("getServerConfigPath (no server configured must not invent one)", () => {
  beforeEach(() => {
    getCurrentServer.mockReset();
    getAllSettings.mockReset();
  });

  it("throws ServerNotConfiguredError rather than defaulting to ~/Zomboid/Server when nothing is configured", async () => {
    getCurrentServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  it("throws even when an active server row exists but has no path anywhere and no legacy fallback either", async () => {
    getCurrentServer.mockResolvedValue({ id: "1", serverName: "Ghost" });
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  it("does not take the legacy config path when an active server has none", async () => {
    getCurrentServer.mockResolvedValue({ id: "2", serverName: "NewServer" });
    getAllSettings.mockResolvedValue({ serverConfigPath: "/old/Server" });
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  it("resolves the active server's explicit serverConfigPath when set", async () => {
    getCurrentServer.mockResolvedValue({ serverConfigPath: "/srv/pz/Server" });
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).resolves.toBe("/srv/pz/Server");
  });

  it("falls back to the active server's zomboidDataPath + Server when no explicit config path is set", async () => {
    getCurrentServer.mockResolvedValue({ zomboidDataPath: "/data/zomboid" });
    getAllSettings.mockResolvedValue({});
    const result = await getServerConfigPath();
    expect(result).toBe(path.join("/data/zomboid", "Server"));
  });

  it("falls back to legacy settings.serverConfigPath when there is no active server", async () => {
    getCurrentServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverConfigPath: "/legacy/Server" });
    await expect(getServerConfigPath()).resolves.toBe("/legacy/Server");
  });

  it("falls back to legacy settings.zomboidDataPath + Server when there is no active server", async () => {
    getCurrentServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ zomboidDataPath: "/legacy/zomboid" });
    const result = await getServerConfigPath();
    expect(result).toBe(path.join("/legacy/zomboid", "Server"));
  });
});

describe("INI round-trip helpers", () => {
  it("writes a changed value back to the same key while preserving comments", () => {
    const original = "; server config\nMinutesPerPage=2\nPublic=true\n";
    const settings = { ...parseIni(original), MinutesPerPage: "3" };
    const written = toIni(settings, original);

    expect(written).toContain("; server config");
    expect(parseIni(written).MinutesPerPage).toBe("3");
    expect(parseIni(written).Public).toBe("true");
  });

  it("does not add empty values for keys absent from a new INI", () => {
    const written = toIni({ MinutesPerPage: "", Public: "true" });

    expect(written).toBe("Public=true");
  });
});

import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { ensureRconConfigured } = await import("../routes/server.js");

describe("ensureRconConfigured() -- INI path resolution", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getActiveServer.mockReset();
  });

  function baseServer(overrides = {}) {
    return {
      serverName: "servertest",
      rconPassword: "secret123",
      rconPort: 27015,
      ...overrides,
    };
  }

  it("an existing INI at the default Server/ subdirectory is patched in place, not replaced", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    const serverDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    const iniPath = path.join(serverDir, "servertest.ini");
    fs.writeFileSync(
      iniPath,
      "PVP=false\nPauseEmpty=true\nRCONPassword=old\nRCONPort=27015\n",
      "utf-8",
    );

    getActiveServer.mockResolvedValue(baseServer({ zomboidDataPath }));

    const result = await ensureRconConfigured();
    expect(result).toBe(true);

    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain("PVP=false");
    expect(content).toContain("PauseEmpty=true");
    expect(content).toContain("RCONPassword=secret123");
  });

  it("an existing INI at the LEGACY location (directly under zomboidDataPath, no Server/ subdir) is found and patched -- not wrongly treated as missing", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    const iniPath = path.join(zomboidDataPath, "servertest.ini");
    fs.writeFileSync(
      iniPath,
      "PVP=true\nMaxPlayers=32\nRCONPassword=old\nRCONPort=27015\n",
      "utf-8",
    );

    getActiveServer.mockResolvedValue(baseServer({ zomboidDataPath }));

    const result = await ensureRconConfigured();
    expect(result).toBe(true);

    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain("PVP=true");
    expect(content).toContain("MaxPlayers=32");
    expect(content).toContain("RCONPassword=secret123");

    const wrongPath = path.join(zomboidDataPath, "Server", "servertest.ini");
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  it("an existing INI named serveroptions.ini (another recognized legacy name) is found and patched", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    const iniPath = path.join(zomboidDataPath, "serveroptions.ini");
    fs.writeFileSync(
      iniPath,
      "Public=true\nRCONPassword=old\nRCONPort=27015\n",
      "utf-8",
    );

    getActiveServer.mockResolvedValue(baseServer({ zomboidDataPath }));

    const result = await ensureRconConfigured();
    expect(result).toBe(true);

    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain("Public=true");
    expect(content).toContain("RCONPassword=secret123");
  });

  it("truly no INI anywhere -- still pre-creates the minimal RCON stub at the default Server/ path (unchanged first-run behavior)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-"));
    const zomboidDataPath = path.join(root, "Zomboid");

    getActiveServer.mockResolvedValue(baseServer({ zomboidDataPath }));

    const result = await ensureRconConfigured();
    expect(result).toBe(true);

    const expectedPath = path.join(zomboidDataPath, "Server", "servertest.ini");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, "utf-8")).toContain(
      "RCONPassword=secret123",
    );
  });

  it("an explicit serverConfigPath takes priority over the legacy fallbacks when an INI exists at both", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    const explicitConfigPath = path.join(root, "CustomConfigDir");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.mkdirSync(explicitConfigPath, { recursive: true });

    const explicitIni = path.join(explicitConfigPath, "servertest.ini");
    fs.writeFileSync(explicitIni, "FromExplicitPath=true\n", "utf-8");
    const legacyIni = path.join(zomboidDataPath, "servertest.ini");
    fs.writeFileSync(legacyIni, "FromLegacyPath=true\n", "utf-8");

    getActiveServer.mockResolvedValue(
      baseServer({ zomboidDataPath, serverConfigPath: explicitConfigPath }),
    );

    await ensureRconConfigured();

    expect(fs.readFileSync(explicitIni, "utf-8")).toContain("FromExplicitPath=true");
    expect(fs.readFileSync(explicitIni, "utf-8")).toContain("RCONPassword=secret123");
    expect(fs.readFileSync(legacyIni, "utf-8")).toBe("FromLegacyPath=true\n");
  });

  it("a ServerWelcomeMessage containing the literal text 'RCONPassword=' is left untouched, not rewritten as a second credential line", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    const serverDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    const iniPath = path.join(serverDir, "servertest.ini");
    const welcomeLine =
      'ServerWelcomeMessage="Ask an admin, never share RCONPassword=hunter2 with anyone."';
    fs.writeFileSync(
      iniPath,
      `PVP=false\n${welcomeLine}\nRCONPassword=old\nRCONPort=27015\n`,
      "utf-8",
    );

    getActiveServer.mockResolvedValue(baseServer({ zomboidDataPath }));

    const result = await ensureRconConfigured();
    expect(result).toBe(true);

    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("RCONPassword=secret123");
    expect(content.match(/^RCONPassword=/gm)).toHaveLength(1);
  });
});

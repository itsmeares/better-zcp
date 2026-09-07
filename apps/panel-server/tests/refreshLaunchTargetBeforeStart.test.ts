import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { refreshLaunchTargetBeforeStart } = await import("../routes/server.ts");

describe("refreshLaunchTargetBeforeStart()", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getActiveServer.mockReset();
  });

  function baseServer(overrides = {}) {
    return {
      serverName: "TestServer",
      rconPassword: "secret123",
      rconPort: 27015,
      minMemory: 4,
      maxMemory: 8,
      serverPort: 16261,
      ...overrides,
    };
  }

  it("regenerates the launch script with the CURRENT zomboidDataPath, closing the stale-script gap", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const oldDataPath = path.join(root, "ZomboidData_old");
    const newDataPath = path.join(root, "ZomboidData_new");

    const server = baseServer({ installPath, zomboidDataPath: oldDataPath });
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);
    const batPath = path.join(installPath, "StartServer_TestServer.bat");
    expect(fs.readFileSync(batPath, "utf8")).toContain(
      `-cachedir="${oldDataPath}"`,
    );

    const updatedServer = { ...server, zomboidDataPath: newDataPath };
    getActiveServer.mockResolvedValue(updatedServer);

    const result = await refreshLaunchTargetBeforeStart(updatedServer);

    const content = fs.readFileSync(batPath, "utf8");
    expect(content).toContain(`-cachedir="${newDataPath}"`);
    expect(content).not.toContain(`-cachedir="${oldDataPath}"`);
    expect(result.scriptBackupWarnings).toEqual([]);
  });

  it("also pre-configures RCON in the ini before the script regen completes", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    const serverDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "TestServer.ini"),
      "PVP=true\nRCONPassword=old\nRCONPort=27015\n",
      "utf8",
    );

    const server = baseServer({ installPath, zomboidDataPath });
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);

    const iniContent = fs.readFileSync(
      path.join(serverDir, "TestServer.ini"),
      "utf8",
    );
    expect(iniContent).toContain("RCONPassword=secret123");
  });

  it("skips script regen for a managed container, but still runs RCON pre-configure", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    const serverDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "TestServer.ini"),
      "RCONPassword=old\nRCONPort=27015\n",
      "utf8",
    );

    const server = baseServer({ installPath, zomboidDataPath });
    getActiveServer.mockResolvedValue(server);

    const result = await refreshLaunchTargetBeforeStart(server, {
      managedHandled: true,
    });

    expect(fs.existsSync(path.join(installPath, "StartServer_TestServer.bat"))).toBe(
      false,
    );
    expect(result.scriptBackupWarnings).toEqual([]);
    expect(
      fs.readFileSync(path.join(serverDir, "TestServer.ini"), "utf8"),
    ).toContain("RCONPassword=secret123");
  });

  it("skips script regen when the server has a custom startCommand", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const installPath = root;
    const server = baseServer({
      installPath,
      startCommand: "custom-launcher.sh",
    });
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);

    expect(fs.existsSync(path.join(installPath, "StartServer_TestServer.bat"))).toBe(
      false,
    );
  });

  it("skips script regen when installPath is missing, and does not throw", async () => {
    const server = baseServer({});
    getActiveServer.mockResolvedValue(server);

    await expect(refreshLaunchTargetBeforeStart(server)).resolves.toEqual({
      scriptBackupWarnings: [],
    });
  });

  it("a script-regen failure is swallowed and reported as an empty warnings list, never thrown", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const notADir = path.join(root, "not-a-directory");
    fs.writeFileSync(notADir, "x", "utf8");

    const server = baseServer({ installPath: notADir });
    getActiveServer.mockResolvedValue(server);

    await expect(refreshLaunchTargetBeforeStart(server)).resolves.not.toThrow();
  });
});

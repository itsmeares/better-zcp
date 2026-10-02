import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";

const getCurrentServer = vi.fn();
vi.mock("../database/init.ts", () => ({
  getCurrentServer: (...args) => getCurrentServer(...args),
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
    getCurrentServer.mockReset();
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
    getCurrentServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);
    const batPath = path.join(installPath, "StartServer_TestServer.bat");
    expect(fs.readFileSync(batPath, "utf8")).toContain(
      `-cachedir=^"${oldDataPath}^"`,
    );

    const updatedServer = { ...server, zomboidDataPath: newDataPath };
    getCurrentServer.mockResolvedValue(updatedServer);

    const result = await refreshLaunchTargetBeforeStart(updatedServer);

    const content = fs.readFileSync(batPath, "utf8");
    expect(content).toContain(`-cachedir=^"${newDataPath}^"`);
    expect(content).not.toContain(`-cachedir=^"${oldDataPath}^"`);
    expect(result.scriptBackupWarnings).toEqual([]);
  });

  it("refuses invalid launch input instead of reusing a stale script", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-invalid-"));
    const script = path.join(root, "StartServer_TestServer.bat");
    fs.writeFileSync(script, "original launcher");
    getCurrentServer.mockResolvedValue(null);
    await expect(refreshLaunchTargetBeforeStart(baseServer({
      installPath: root,
      adminPassword: "bad\necho INJECTED",
    }))).rejects.toThrow("Admin password must be text without control characters");
    expect(fs.readFileSync(script, "utf8")).toBe("original launcher");
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
    getCurrentServer.mockResolvedValue(server);

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
    getCurrentServer.mockResolvedValue(server);

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
    getCurrentServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server);

    expect(fs.existsSync(path.join(installPath, "StartServer_TestServer.bat"))).toBe(
      false,
    );
  });

  it("skips script regen when installPath is missing, and does not throw", async () => {
    const server = baseServer({});
    getCurrentServer.mockResolvedValue(server);

    await expect(refreshLaunchTargetBeforeStart(server)).resolves.toEqual({
      scriptBackupWarnings: [],
    });
  });

  it("a script-regen failure is swallowed and reported as an empty warnings list, never thrown", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-refresh-launch-"));
    const notADir = path.join(root, "not-a-directory");
    fs.writeFileSync(notADir, "x", "utf8");

    const server = baseServer({ installPath: notADir });
    getCurrentServer.mockResolvedValue(server);

    await expect(refreshLaunchTargetBeforeStart(server)).resolves.not.toThrow();
  });
});

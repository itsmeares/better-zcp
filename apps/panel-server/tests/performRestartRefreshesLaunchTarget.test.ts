import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";

const getServer = vi.fn();
const getActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
}));

const { Scheduler } = await import("../services/scheduler.ts");

describe("performRestart() refreshes the launch target before starting", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getServer.mockReset();
    getActiveServer.mockReset();
  });

  it("a scheduled restart of an already-stopped server regenerates the launch script against CURRENT settings before starting", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-perform-restart-"));
    const installPath = root;
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });

    const server = {
      id: 7,
      serverName: "TestServer",
      installPath,
      zomboidDataPath,
      rconPassword: "secret123",
      rconPort: 27015,
      adminPassword: "admin123",
    };
    getServer.mockResolvedValue(server);
    getActiveServer.mockResolvedValue(server);

    const scheduler = new Scheduler({}, {});
    scheduler.sleep = async () => {};

    const rconService = { connected: false, execute: vi.fn() };
    const serverManager = {
      _serverId: 7,
      getServerProcessDetails: vi
        .fn()
        .mockResolvedValue({ running: false, scanFailed: false }),
      startServer: vi.fn().mockResolvedValue({ success: true }),
    };

    await scheduler.performRestart(0, { rconService, serverManager });

    const batPath = path.join(installPath, "StartServer_TestServer.bat");
    expect(fs.existsSync(batPath)).toBe(true);
    expect(fs.readFileSync(batPath, "utf8")).toContain(
      `-cachedir="${zomboidDataPath}"`,
    );
    expect(serverManager.startServer).toHaveBeenCalled();
  });

});

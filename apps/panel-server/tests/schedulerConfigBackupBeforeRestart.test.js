import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getServer = vi.fn();
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
}));

vi.mock("../utils/configBackup.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBackupIfChanged: vi.fn(actual.createBackupIfChanged) };
});

const { Scheduler } = await import("../services/scheduler.ts");
const { createBackupIfChanged } = await import("../utils/configBackup.ts");

describe("Scheduler._backupConfigBeforeRestart()", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getServer.mockReset();
    getActiveServer.mockReset();
    createBackupIfChanged.mockClear();
  });

  function makeScheduler() {
    return new Scheduler({}, {});
  }

  function writeConfigFixture() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-scheduler-backup-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    const configDir = path.join(zomboidDataPath, "Server");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "servertest.ini"), "PVP=true\n", "utf8");
    fs.writeFileSync(
      path.join(configDir, "servertest_SandboxVars.lua"),
      "SandboxVars = {\n  ZombieConfig = {},\n}\n",
      "utf8",
    );
    return { zomboidDataPath, configDir };
  }

  it("backs up both the live ini and SandboxVars.lua for the pinned server before a restart", async () => {
    const { zomboidDataPath, configDir } = writeConfigFixture();
    getServer.mockResolvedValue({
      id: 5,
      serverName: "servertest",
      zomboidDataPath,
    });

    const scheduler = makeScheduler();
    await scheduler._backupConfigBeforeRestart(5);

    expect(getServer).toHaveBeenCalledWith(5);
    const backupDir = path.join(configDir, "backups");
    const backups = fs.readdirSync(backupDir);
    const iniBackup = backups.find((f) => f.startsWith("servertest.ini."));
    const sandboxBackup = backups.find((f) =>
      f.startsWith("servertest_SandboxVars.lua."),
    );
    expect(iniBackup).toBeTruthy();
    expect(sandboxBackup).toBeTruthy();
    expect(fs.readFileSync(path.join(backupDir, iniBackup), "utf8")).toBe(
      "PVP=true\n",
    );
  });

  it("falls back to the active server when no restart was pinned to a specific server", async () => {
    const { zomboidDataPath, configDir } = writeConfigFixture();
    getActiveServer.mockResolvedValue({
      serverName: "servertest",
      zomboidDataPath,
    });

    const scheduler = makeScheduler();
    await scheduler._backupConfigBeforeRestart(null);

    expect(getActiveServer).toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();
    const backupDir = path.join(configDir, "backups");
    expect(
      fs.readdirSync(backupDir).some((f) => f.startsWith("servertest.ini.")),
    ).toBe(true);
  });

  it("many restarts in a row with no config change in between do not flood the keep-10 retention quota", async () => {
    const { zomboidDataPath, configDir } = writeConfigFixture();
    getServer.mockResolvedValue({
      id: 5,
      serverName: "servertest",
      zomboidDataPath,
    });

    const scheduler = makeScheduler();
    for (let i = 0; i < 12; i++) {
      await scheduler._backupConfigBeforeRestart(5);
    }

    const backupDir = path.join(configDir, "backups");
    const backups = fs.readdirSync(backupDir);
    const iniBackups = backups.filter((f) => f.startsWith("servertest.ini."));
    const sandboxBackups = backups.filter((f) =>
      f.startsWith("servertest_SandboxVars.lua."),
    );
    expect(iniBackups).toHaveLength(1);
    expect(sandboxBackups).toHaveLength(1);
  });

  it("a real config change between two restarts produces a second, distinct backup", async () => {
    const { zomboidDataPath, configDir } = writeConfigFixture();
    getServer.mockResolvedValue({
      id: 5,
      serverName: "servertest",
      zomboidDataPath,
    });

    const scheduler = makeScheduler();
    await scheduler._backupConfigBeforeRestart(5);

    fs.writeFileSync(
      path.join(configDir, "servertest.ini"),
      "PVP=true\nMaxPlayers=64\n",
      "utf8",
    );
    await scheduler._backupConfigBeforeRestart(5);

    const backupDir = path.join(configDir, "backups");
    const iniBackups = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("servertest.ini."));
    expect(iniBackups).toHaveLength(2);
  });

  it("no server configured (no zomboidDataPath/serverConfigPath): does not throw, backs up nothing, still returns the server record", async () => {
    const server = { id: 5, serverName: "servertest" };
    getServer.mockResolvedValue(server);

    const scheduler = makeScheduler();
    await expect(scheduler._backupConfigBeforeRestart(5)).resolves.toEqual(server);
    expect(createBackupIfChanged).not.toHaveBeenCalled();
  });

  it("a database failure while resolving the server never throws out of the restart flow, and returns null", async () => {
    getServer.mockRejectedValue(new Error("db unavailable"));

    const scheduler = makeScheduler();
    await expect(scheduler._backupConfigBeforeRestart(5)).resolves.toBeNull();
  });

  it("an ini at the LEGACY location (directly under zomboidDataPath, no Server/ subdir) is found and backed up, not skipped", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-scheduler-backup-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.writeFileSync(
      path.join(zomboidDataPath, "servertest.ini"),
      "PVP=true\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(zomboidDataPath, "servertest_SandboxVars.lua"),
      "SandboxVars = {}\n",
      "utf8",
    );

    getServer.mockResolvedValue({
      id: 5,
      serverName: "servertest",
      zomboidDataPath,
    });

    const scheduler = makeScheduler();
    await scheduler._backupConfigBeforeRestart(5);

    const backupDir = path.join(zomboidDataPath, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups.some((f) => f.startsWith("servertest.ini."))).toBe(true);
    expect(
      backups.some((f) => f.startsWith("servertest_SandboxVars.lua.")),
    ).toBe(true);

    expect(fs.existsSync(path.join(zomboidDataPath, "Server"))).toBe(false);
  });

  it("the sandbox filename is derived from the ini that was actually found, not server.serverName, when they differ", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-scheduler-backup-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.writeFileSync(
      path.join(zomboidDataPath, "serveroptions.ini"),
      "PVP=true\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(zomboidDataPath, "serveroptions_SandboxVars.lua"),
      "SandboxVars = {}\n",
      "utf8",
    );

    getServer.mockResolvedValue({
      id: 5,
      serverName: "MyCoolServer",
      zomboidDataPath,
    });

    const scheduler = makeScheduler();
    await scheduler._backupConfigBeforeRestart(5);

    const backupDir = path.join(zomboidDataPath, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(
      backups.some((f) => f.startsWith("serveroptions_SandboxVars.lua.")),
    ).toBe(true);
    expect(
      backups.some((f) => f.startsWith("MyCoolServer_SandboxVars.lua.")),
    ).toBe(false);
  });
});

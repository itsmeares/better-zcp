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

// A pass-through spy, not a stub: wraps the REAL createBackupIfChanged so
// every other test in this file keeps taking real backups and checking
// real files on disk (unchanged) -- only wrapped so a call count can be
// asserted where the claim under test is specifically "backs up nothing"
// (bug hunt 2026-08-31-c, under-coverage sweep). Does not touch
// services/scheduler.js.
vi.mock("../utils/configBackup.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBackupIfChanged: vi.fn(actual.createBackupIfChanged) };
});

const { Scheduler } = await import("../services/scheduler.js");
const { createBackupIfChanged } = await import("../utils/configBackup.js");

// 2026-08-27, operator directive ("make sure backups works") relayed by god,
// safety-net follow-up: confirmed (by grep, not guesswork) that
// createBackup()/writeIniWithBackup() only ever fire from an explicit human
// edit-and-save action -- no restart, scheduled or manual, ever took a
// config backup. loonE's Discord report (servertest.ini/SandboxVars.lua
// reverted to default after a SCHEDULED reboot) recovered from Project
// Zomboid's OWN backup folder, not the panel's, because the panel's had
// nothing to offer -- a safety net that only deploys when a human is
// present and watching is not a safety net.
//
// _backupConfigBeforeRestart() is the fix: called once from
// performRestart(), the ONE call site every restart trigger funnels
// through (manual Dashboard/Scheduler-page/Discord restart, and automated
// AUTO_RESTART_CRON / mod-update-triggered restart alike), right after the
// old process is confirmed stopped and before the new one starts. This
// file tests it directly rather than through the full performRestart()
// flow, which involves real multi-minute countdowns and RCON polling loops
// unsuited to a unit test.
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

  // The treadmill risk god explicitly flagged: a server that restarts on a
  // schedule calls this on every single restart, whether or not the
  // operator has touched config since the last one.
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
    // One each -- not 12, not anywhere near the keep-10 ceiling.
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

    // An operator edits the ini between two scheduled restarts.
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
    // bug hunt 2026-08-31-c (under-coverage sweep): "backs up nothing" is a
    // claim about whether a backup was ATTEMPTED, not just what the method
    // returned -- the resolved-value check above says nothing about that.
    expect(createBackupIfChanged).not.toHaveBeenCalled();
  });

  it("a database failure while resolving the server never throws out of the restart flow, and returns null", async () => {
    getServer.mockRejectedValue(new Error("db unavailable"));

    const scheduler = makeScheduler();
    await expect(scheduler._backupConfigBeforeRestart(5)).resolves.toBeNull();
  });

  // 2026-08-27, operator-flagged limitation fix: this method originally
  // only checked serverConfigPath-or-zomboidDataPath/Server, never the
  // legacy fallback locations ensureRconConfigured() already knows about
  // -- exactly the installs the stale-launch-script defect
  // (refreshLaunchTargetBeforeStart) is most likely to hit, since an ini
  // sitting at a legacy location is itself a sign this install's config
  // resolution has already drifted from the default once.
  it("an ini at the LEGACY location (directly under zomboidDataPath, no Server/ subdir) is found and backed up, not skipped", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-scheduler-backup-"));
    const zomboidDataPath = path.join(root, "Zomboid");
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    // Deliberately no Server/ subdirectory -- only the legacy path, same
    // shape as the ensureRconConfigured() legacy-path regression test.
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

    // Nothing must have been created at the default Server/ path, which is
    // what the pre-fix version of this method would have checked instead.
    expect(fs.existsSync(path.join(zomboidDataPath, "Server"))).toBe(false);
  });

  // The sandbox filename must follow whichever ini was actually found, not
  // blindly server.serverName -- the "serveroptions.ini" legacy fallback
  // uses a fixed name that can differ from the configured server name.
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

    // Configured serverName differs from the fixed legacy filename on disk.
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
    // Must NOT have gone looking for a MyCoolServer_SandboxVars.lua that
    // was never there.
    expect(
      backups.some((f) => f.startsWith("MyCoolServer_SandboxVars.lua.")),
    ).toBe(false);
  });
});

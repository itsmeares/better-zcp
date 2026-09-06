import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LINUX BUG HUNT (2026-08-29, hunt-wave5, card 9fe76d): "OVERLAP -- can a
// scheduled restart start while a previous one is still running, or while a
// backup is mid-write?"
//
// createBackup() (backupService.js) zips whatever is currently on disk under
// savesPath with no awareness of Scheduler.restartInProgress. performRestart()
// sends an RCON `save` (writes NEW save bytes) and then stops/starts the
// server -- both windows overlap with exactly the files createBackup() reads.
// A scheduled backup firing during either window can archive a save mid-write,
// a corrupt/inconsistent snapshot indistinguishable from a real backup until
// someone tries to restore it. This proves the fix: the scheduled-backup cron
// callback now checks restartInProgress and skips (with a visible Schedule
// History entry, not a silent no-op) rather than racing the restart.
//
// Deliberately one-directional (only the backup side defers): making a
// RESTART wait on a backup would delay something that can be genuinely
// time-sensitive (an operator's "Restart Now", a mod-update trigger),
// whereas deferring an automatic backup a few minutes is harmless -- the
// next scheduled tick, or a manual "Create Backup Now", covers it.

const logScheduleExecution = vi.fn().mockResolvedValue();

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: vi.fn(),
  getServer: vi.fn(),
}));

let capturedBackupCallback = null;

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expression, callback) => {
      capturedBackupCallback = callback;
      return {
        stop: vi.fn(),
        getNextRun: () => null,
      };
    }),
    validate: vi.fn(() => true),
  },
}));

const { Scheduler } = await import("../services/scheduler.js");

describe("Scheduler: scheduled backup defers to an in-progress restart", () => {
  let scheduler;
  let createBackup;

  beforeEach(() => {
    capturedBackupCallback = null;
    logScheduleExecution.mockClear();
    scheduler = new Scheduler({}, {});
    createBackup = vi.fn().mockResolvedValue({
      success: true,
      backup: { name: "test-backup.zip" },
    });
    scheduler.setBackupService({
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        schedule: "0 */12 * * *", // the real operator's live config, per the card
        includeDb: false,
      }),
      createBackup,
    });
  });

  afterEach(() => {
    if (scheduler.backupJob) scheduler.backupJob.stop();
  });

  it("skips the backup (logged, not silent) when a restart is currently in progress", async () => {
    await scheduler.setupBackupSchedule();
    expect(capturedBackupCallback).toBeTypeOf("function");

    scheduler.restartInProgress = true;
    await capturedBackupCallback();

    expect(createBackup).not.toHaveBeenCalled();
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Scheduled Backup",
      "backup",
      false,
      expect.stringMatching(/restart was in progress/i),
      0,
    );
  });

  it("positive control: runs the backup normally when no restart is in progress", async () => {
    await scheduler.setupBackupSchedule();
    expect(capturedBackupCallback).toBeTypeOf("function");

    scheduler.restartInProgress = false;
    await capturedBackupCallback();

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Scheduled Backup",
      "backup",
      true,
      expect.stringContaining("test-backup.zip"),
      expect.any(Number),
    );
  });
});

describe("Scheduler.getStatus(): surfaces the timezone every cron.schedule() call actually uses", () => {
  // Suspect 1 (timezone): no cron.schedule() call in this file passes an
  // explicit `timezone` option, so node-cron resolves every schedule --
  // task jobs, the backup job, AUTO_RESTART_CRON -- against the PROCESS's
  // own default timezone (Intl.DateTimeFormat().resolvedOptions().timeZone).
  // Neither the Dockerfile nor docker-compose.yml sets TZ, so a
  // containerized install silently defaults to UTC regardless of the
  // operator's own timezone, and the Scheduler UI gives zero indication of
  // this. Proves getStatus() now reports the REAL, currently-effective
  // value so the UI can stop being silent about it.
  it("reports the process's actual resolved timezone, not a hardcoded guess", () => {
    const scheduler = new Scheduler({}, {});
    const status = scheduler.getStatus();
    expect(status.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(typeof status.timezone).toBe("string");
    expect(status.timezone.length).toBeGreaterThan(0);
  });
});

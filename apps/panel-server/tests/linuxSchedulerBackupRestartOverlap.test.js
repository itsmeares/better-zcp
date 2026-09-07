import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


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

const { Scheduler } = await import("../services/scheduler.ts");

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
  it("reports the process's actual resolved timezone, not a hardcoded guess", () => {
    const scheduler = new Scheduler({}, {});
    const status = scheduler.getStatus();
    expect(status.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(typeof status.timezone).toBe("string");
    expect(status.timezone.length).toBeGreaterThan(0);
  });
});

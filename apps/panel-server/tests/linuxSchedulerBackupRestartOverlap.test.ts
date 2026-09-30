import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";


const logScheduleExecution = vi.fn().mockResolvedValue();

vi.mock("../database/init.ts", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getCurrentServer: vi.fn(),
  getServer: vi.fn(),
}));

let capturedBackupCallback = null;
let capturedMissedHandler = null;

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expression, callback) => {
      capturedBackupCallback = callback;
      return {
        stop: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === "execution:missed") capturedMissedHandler = handler;
        }),
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
    capturedMissedHandler = null;
    logScheduleExecution.mockClear();
    scheduler = new Scheduler({}, {}, { active: null, cancel: () => false, run: async () => ({ success: true }) });
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

  it("logs a deferred result from the common backup flow", async () => {
    createBackup.mockResolvedValue({ success: false, deferred: true, message: "Restart already in progress" });
    await scheduler.setupBackupSchedule(); await capturedBackupCallback();
    expect(logScheduleExecution).toHaveBeenCalledWith(null, "Scheduled Backup", "backup", false, "Restart already in progress", expect.any(Number));
  });

  it("positive control: runs the backup normally when no restart is in progress", async () => {
    await scheduler.setupBackupSchedule();
    expect(capturedBackupCallback).toBeTypeOf("function");

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

  it("records a visible history entry when node-cron reports a missed backup", async () => {
    await scheduler.setupBackupSchedule();
    capturedMissedHandler({ dateLocalIso: "2026-09-05T02:00:00.000Z" });

    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Scheduled Backup",
      "backup",
      false,
      expect.stringContaining("Missed scheduled run at 2026-09-05T02:00:00.000Z"),
      0,
    );
  });
});

describe("Scheduler.getStatus(): surfaces the timezone every cron.schedule() call actually uses", () => {
  it("reports the process's actual resolved timezone, not a hardcoded guess", () => {
    const scheduler = new Scheduler({}, {}, { active: null, cancel: () => false, run: async () => ({ success: true }) });
    const status = scheduler.getStatus();
    expect(status.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(typeof status.timezone).toBe("string");
    expect(status.timezone.length).toBeGreaterThan(0);
  });
});

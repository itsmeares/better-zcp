import { describe, expect, it, vi } from "vite-plus/test";


const logScheduleExecution = vi.fn().mockResolvedValue();

vi.mock("../database/init.ts", () => ({
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
        on: vi.fn(),
        getNextRun: () => null,
      };
    }),
    validate: vi.fn(() => true),
  },
}));

const { Scheduler } = await import("../services/scheduler.ts");

describe("Scheduler: scheduled-backup skip note is cause-agnostic, not hardcoded to 'vanished during archiving'", () => {
  it("does not claim a deliberately-skipped symlink 'vanished during archiving'", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler.setBackupService({
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        schedule: "0 */12 * * *",
        includeDb: false,
      }),
      createBackup: vi.fn().mockResolvedValue({
        success: true,
        backup: { name: "test-backup.zip" },
        skippedFiles: ["Zomboid/Server/link-to-somewhere"],
      }),
    });

    await scheduler.setupBackupSchedule();
    expect(capturedBackupCallback).toBeTypeOf("function");
    await capturedBackupCallback();
    scheduler.backupJob?.stop();

    const call = logScheduleExecution.mock.calls.find(
      (args) => args[1] === "Scheduled Backup" && args[3] === true,
    );
    expect(call).toBeDefined();
    const message = call[4];
    expect(message).toContain("link-to-somewhere");
    expect(message).not.toMatch(/vanished/i);
    expect(message).toMatch(/symbolic link/i);
  });
});

describe("scheduled full backup deadline", () => {
  it("requires each countdown warning to be accepted by RCON", async () => {
    const serverMessage = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, rejected: true });
    const scheduler = new Scheduler({ serverMessage }, {});
    scheduler.sleep = vi.fn().mockResolvedValue(undefined);

    await expect(scheduler.warnForForcedBackup(null, 15, 0)).resolves.toBe(false);
    expect(serverMessage).toHaveBeenCalledTimes(2);
    expect(serverMessage.mock.calls[0][0]).toContain("15 minute");
    expect(serverMessage.mock.calls[1][0]).toContain("10 minute");
  });

  it("does not stop an occupied server when player warnings fail", async () => {
    const scheduler = new Scheduler({
      getPlayers: vi.fn().mockResolvedValue({ success: true, players: ["online"] }),
    }, {});
    const createBackup = vi.fn();
    scheduler.setBackupService({
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        schedule: "0 */12 * * *",
        includeDb: false,
        forceAfterMinutes: 15,
        forceWarningMinutes: 15,
      }),
      createBackup,
    });
    vi.spyOn(scheduler, "warnForForcedBackup").mockResolvedValue(false);

    await scheduler.setupBackupSchedule();
    await capturedBackupCallback();

    expect(createBackup).not.toHaveBeenCalled();
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null, "Scheduled Backup", "backup", false,
      expect.stringContaining("warning"), expect.any(Number),
    );
    scheduler.stopAllJobs();
  });

  it("does not bypass the player check without an explicit deadline", async () => {
    const scheduler = new Scheduler({}, {});
    const createBackup = vi.fn().mockResolvedValue({ success: false, deferred: true, message: "Players online" });
    scheduler.setBackupService({
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        schedule: "0 */12 * * *",
        includeDb: false,
        forceAfterMinutes: null,
        forceWarningMinutes: 15,
      }),
      createBackup,
    });

    await scheduler.setupBackupSchedule();
    await capturedBackupCallback();

    expect(createBackup).toHaveBeenCalledWith(expect.objectContaining({
      scheduled: true,
      allowOccupiedScheduled: false,
    }));
    scheduler.stopAllJobs();
  });
});

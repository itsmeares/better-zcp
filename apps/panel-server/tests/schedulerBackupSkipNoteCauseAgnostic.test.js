import { describe, expect, it, vi } from "vitest";


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

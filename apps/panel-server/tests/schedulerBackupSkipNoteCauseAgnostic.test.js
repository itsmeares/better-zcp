import { describe, expect, it, vi } from "vitest";

// bughunt-2026-08-31-c, completeness-claims-audit-followups: a comment in
// backupService.js claimed "both reasons already get identical treatment
// by every consumer of skippedFiles" -- but this file's own scheduled-
// backup skip note still hardcoded "that vanished during archiving", the
// pre-2026-08-29 wording, after walkDirectory() started also recording a
// deliberately-excluded symbolic link in the same skippedFiles array
// (445c15a5). A symlink was never "vanished"; it was never followed on
// purpose. routes/backup.js's equivalent operator-facing warning was
// updated to cause-agnostic wording in that same commit -- this one, in
// Schedule History (the only place an unattended run's skip is ever
// visible), was not.
//
// Same capture-the-cron-callback technique as
// linuxSchedulerBackupRestartOverlap.test.js.

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
        // A symlink skip, not a vanished-mid-archive skip -- see
        // walkDirectory()'s own { isSymlink: true } marker in
        // backupService.js.
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

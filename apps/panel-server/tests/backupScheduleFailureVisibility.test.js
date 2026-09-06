import { afterEach, describe, expect, it } from "vitest";

// 2026-08-29 backlog card (god): backup-card-not-bridged-to-scheduler-
// failure-logging. Confirmed the premise still holds at current main: the
// Backups page's "Auto-Backup" status card reads only `settings.enabled`
// (a toggle) and `lastBackup` (only ever updated on a SUCCESSFUL backup) --
// scheduler.js's cron job already logs every scheduled attempt, success or
// failure, via logScheduleExecution() into schedule_history, but nothing
// carried that into backupService.getStatus(), so an operator could have a
// scheduler failing every single attempt while the card kept showing
// "Auto-Backup: On" in its normal (non-warning) color, same shape as the
// other "capable of working is not working" defects found today.
//
// Real database/init.js (not mocked) -- same per-test-file real dataDir as
// circuitBreakerStatus.test.js -- and the real BackupService, so this
// exercises the actual schedule_history round trip rather than a mock of
// it.
const { logScheduleExecution, setSetting } = await import("../database/init.js");
const { BackupService } = await import("../services/backupService.js");

afterEach(async () => {
  // Leave settings/history clean for later tests in the same run.
  await setSetting("backupEnabled", null);
});

describe("BackupService.getStatus() -- surfaces the newest SCHEDULED backup attempt, not just the newest successful file", () => {
  it("is null when scheduled backups are disabled, even if a failure is sitting in schedule_history", async () => {
    await logScheduleExecution(null, "Scheduled Backup", "backup", false, "disk full", 120);
    await setSetting("backupEnabled", false);

    const status = await new BackupService().getStatus();
    expect(status.lastScheduledBackupAttempt).toBeNull();
  });

  it("reports the last scheduled attempt as a failure when it was one", async () => {
    await setSetting("backupEnabled", true);
    await logScheduleExecution(null, "Scheduled Backup", "backup", true, "Created: old-one.zip", 50);
    await logScheduleExecution(null, "Scheduled Backup", "backup", false, "ENOSPC: no space left on device", 30);

    const status = await new BackupService().getStatus();
    expect(status.lastScheduledBackupAttempt).toEqual(
      expect.objectContaining({ success: false, message: "ENOSPC: no space left on device" }),
    );
  });

  it("reports the last scheduled attempt as a success when it was one, not a stale earlier failure", async () => {
    await setSetting("backupEnabled", true);
    await logScheduleExecution(null, "Scheduled Backup", "backup", false, "ENOSPC: no space left on device", 30);
    await logScheduleExecution(null, "Scheduled Backup", "backup", true, "Created: recovered.zip", 40);

    const status = await new BackupService().getStatus();
    expect(status.lastScheduledBackupAttempt).toEqual(
      expect.objectContaining({ success: true, message: "Created: recovered.zip" }),
    );
  });

  it("is not confused by an unrelated scheduled command sharing taskId=null (e.g. auto-restart)", async () => {
    await setSetting("backupEnabled", true);
    await logScheduleExecution(null, "Scheduled Backup", "backup", true, "Created: base.zip", 40);
    // Auto-restart also logs with taskId=null -- must not be mistaken for a
    // backup attempt just because both share that field.
    await logScheduleExecution(null, "Auto-Restart", "restart", false, "RCON not available", 10);

    const status = await new BackupService().getStatus();
    expect(status.lastScheduledBackupAttempt).toEqual(
      expect.objectContaining({ success: true, message: "Created: base.zip" }),
    );
  });
});

import { afterEach, describe, expect, it } from "vitest";

const { logScheduleExecution, setSetting } = await import("../database/init.js");
const { BackupService } = await import("../services/backupService.ts");

afterEach(async () => {
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
    await logScheduleExecution(null, "Auto-Restart", "restart", false, "RCON not available", 10);

    const status = await new BackupService().getStatus();
    expect(status.lastScheduledBackupAttempt).toEqual(
      expect.objectContaining({ success: true, message: "Created: base.zip" }),
    );
  });
});

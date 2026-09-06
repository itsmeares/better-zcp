import { beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn(async () => null);
const setSetting = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting,
  setSetting,
  logServerEvent: vi.fn(async () => {}),
}));

const { BackupService } = await import("../services/backupService.js");

describe("BackupService.updateSettings schedule validation", () => {
  beforeEach(() => {
    setSetting.mockClear();
  });

  it("rejects seconds-precision schedules before persisting them", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ schedule: "*/5 * * * * *" }),
    ).rejects.toThrow(/exactly 5 cron fields/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects a five-field schedule that runs every minute", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ schedule: "* * * * *" }),
    ).rejects.toThrow(/every 5 minutes/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects a bare minute range that runs more often than every five minutes", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ schedule: "1-4 * * * *" }),
    ).rejects.toThrow(/every 5 minutes/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("accepts a schedule that runs every five minutes", async () => {
    const service = new BackupService();

    await service.updateSettings({ schedule: "*/5 * * * *" });

    expect(setSetting).toHaveBeenCalledWith(
      "backupSchedule",
      "*/5 * * * *",
    );
  });

  it("rejects malformed schedules before persisting them", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ schedule: "not a cron" }),
    ).rejects.toThrow(/exactly 5 cron fields/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("persists a valid five-field schedule", async () => {
    const service = new BackupService();

    await service.updateSettings({ schedule: "0 */6 * * *" });

    expect(setSetting).toHaveBeenCalledWith("backupSchedule", "0 */6 * * *");
  });

  it("rejects a malformed backup count instead of silently substituting a default", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ maxBackups: "not-a-number" }),
    ).rejects.toThrow(/integer between 1 and 100/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not coerce a string boolean into a different persisted value", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ enabled: "false" }),
    ).rejects.toThrow(/enabled must be a boolean/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not partially persist other fields when the schedule is invalid", async () => {
    const service = new BackupService();

    await expect(
      service.updateSettings({ enabled: true, schedule: "not a cron" }),
    ).rejects.toThrow(/exactly 5 cron fields/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects non-finite bulk-delete day values at the service boundary", async () => {
    const service = new BackupService();

    await expect(service.deleteBackupsOlderThan(Number.NaN)).resolves.toEqual({
      success: false,
      message: "Invalid days parameter. Must be a whole number >= 1",
    });
  });

  // bug-hunt-2026-08-26: this was unreachable only because
  // Backups.tsx's delete-days field clamped to whole numbers client-side
  // (and, separately, fought the operator's typing near its own bound --
  // see NumberInput's own header comment). Migrating that field onto the
  // shared NumberInput (type-anything, let the server refuse) makes a
  // fractional value reachable for the first time; without this guard it
  // would have silently reached setDate(getDate() - days), which
  // reinterprets a fractional day count rather than using it as typed.
  it("rejects a fractional bulk-delete day value instead of letting it reach date arithmetic", async () => {
    const service = new BackupService();
    const listBackups = vi.spyOn(service, "listBackups");

    await expect(service.deleteBackupsOlderThan(1.5)).resolves.toEqual({
      success: false,
      message: "Invalid days parameter. Must be a whole number >= 1",
    });
    expect(listBackups).not.toHaveBeenCalled();
  });
});
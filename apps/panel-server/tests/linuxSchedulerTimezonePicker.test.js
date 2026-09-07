import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const settingsStore = new Map();
const getSetting = vi.fn(async (key) => (settingsStore.has(key) ? settingsStore.get(key) : null));
const setSetting = vi.fn(async (key, value) => {
  settingsStore.set(key, value);
});

const logError = vi.fn();
const logWarn = vi.fn();
const logInfo = vi.fn();

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({
    info: (...args) => logInfo(...args),
    warn: (...args) => logWarn(...args),
    error: (...args) => logError(...args),
    debug: vi.fn(),
  }),
}));

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(async () => []),
  updateTaskLastRun: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  logScheduleExecution: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getSetting: (...args) => getSetting(...args),
  setSetting: (...args) => setSetting(...args),
}));

const { Scheduler } = await import("../services/scheduler.ts");
const { getScheduledTasks } = await import("../database/init.js");

function makeScheduler() {
  return new Scheduler({}, {});
}

beforeEach(() => {
  settingsStore.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  logError.mockClear();
  logWarn.mockClear();
  logInfo.mockClear();
});

describe("Scheduler timezone migration: an install with no prior setting keeps EXACTLY its old behavior", () => {
  it("resolves to, and PERSISTS, the process's own currently-effective zone -- not a hardcoded default", async () => {
    const scheduler = makeScheduler();
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const resolved = await scheduler.resolveTimezone();

    expect(resolved).toBe(processDefault);
    expect(scheduler.effectiveTimezone).toBe(processDefault);
    expect(scheduler.configuredTimezone).toBe(processDefault);
    expect(scheduler.timezoneFallback).toBeNull();
    expect(setSetting).toHaveBeenCalledWith("schedulerTimezone", processDefault);
    expect(settingsStore.get("schedulerTimezone")).toBe(processDefault);
  });

  it("THE CARD'S OWN DEFINITION OF DONE: a schedule created before the setting existed fires at the IDENTICAL real-world instant after migration as it would have with no timezone option at all", async () => {
    const cron = (await import("node-cron")).default;
    const preMigrationTask = cron.schedule("30 2 * * *", () => {});
    preMigrationTask.stop();
    const preMigrationNext = preMigrationTask.timeMatcher.getNextMatch(new Date("2026-09-01T00:00:00Z"));

    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();
    const scheduled = scheduler.scheduleTask({
      id: 1,
      name: "Legacy nightly task",
      cron_expression: "30 2 * * *",
      command: "save",
    });
    expect(scheduled).not.toBe(false);
    const job = scheduler.jobs.get(1);
    const postMigrationNext = job.timeMatcher.getNextMatch(new Date("2026-09-01T00:00:00Z"));
    job.stop();

    expect(postMigrationNext.toISOString()).toBe(preMigrationNext.toISOString());
  });

  it("is idempotent -- a second resolveTimezone() call does not re-derive or re-persist, it reads back what migration already wrote", async () => {
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();
    setSetting.mockClear();

    const secondResolve = await scheduler.resolveTimezone();

    expect(setSetting).not.toHaveBeenCalled();
    expect(secondResolve).toBe(scheduler.effectiveTimezone);
  });
});

describe("Scheduler timezone validation: an invalid IANA name is refused at save time", () => {
  it("setTimezone() throws and does NOT persist an invalid zone", async () => {
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();
    const before = settingsStore.get("schedulerTimezone");
    setSetting.mockClear();

    await expect(scheduler.setTimezone("Not/AZone")).rejects.toThrow(/not a valid/i);

    expect(setSetting).not.toHaveBeenCalled();
    expect(settingsStore.get("schedulerTimezone")).toBe(before);
  });

  it("positive control: setTimezone() accepts a real IANA zone and persists it", async () => {
    const scheduler = makeScheduler();
    await scheduler.resolveTimezone();

    await scheduler.setTimezone("Europe/Berlin");

    expect(settingsStore.get("schedulerTimezone")).toBe("Europe/Berlin");
    expect(scheduler.effectiveTimezone).toBe("Europe/Berlin");
  });
});

describe("Scheduler restart warning settings", () => {
  it("persists a valid custom template and makes it effective immediately", async () => {
    const scheduler = makeScheduler();
    const restartWarning = await scheduler.setRestartWarning({
      locale: "zh-CN",
      template: "请在 {count}{unit} 内到安全地点",
    });

    expect(restartWarning).toEqual({
      locale: "zh-CN",
      template: "请在 {count}{unit} 内到安全地点",
    });
    expect(settingsStore.get("restartWarning")).toEqual(restartWarning);
    expect(scheduler.getStatus().restartWarning).toEqual(restartWarning);
  });

  it("rejects invalid settings without overwriting the current warning", async () => {
    const scheduler = makeScheduler();
    await scheduler.setRestartWarning({ locale: "en", template: "Restart in {count} {unit}" });
    setSetting.mockClear();

    await expect(
      scheduler.setRestartWarning({ locale: "en", template: "Restart in {minutes}" }),
    ).rejects.toThrow(/placeholders/i);

    expect(setSetting).not.toHaveBeenCalled();
    expect(scheduler.getStatus().restartWarning.template).toBe("Restart in {count} {unit}");
  });
});

describe("Scheduler timezone fallback: a stored zone that stops being valid fails LOUDLY and keeps running", () => {
  it("falls back to the process default, logs an error, and surfaces the mismatch on timezoneFallback -- does not refuse to start, does not silently substitute", async () => {
    settingsStore.set("schedulerTimezone", "Not/AZone");
    const scheduler = makeScheduler();
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const resolved = await scheduler.resolveTimezone();

    expect(resolved).toBe(processDefault);
    expect(scheduler.effectiveTimezone).toBe(processDefault);
    expect(scheduler.configuredTimezone).toBe("Not/AZone");
    expect(scheduler.timezoneFallback).toEqual({
      configured: "Not/AZone",
      effective: processDefault,
    });
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/not a valid IANA zone/i));

    expect(settingsStore.get("schedulerTimezone")).toBe("Not/AZone");

    const scheduled = scheduler.scheduleTask({
      id: 7,
      name: "Still works",
      cron_expression: "0 3 * * *",
      command: "save",
    });
    expect(scheduled).not.toBe(false);
    scheduler.jobs.get(7).stop();
  });

  it("names the specific raw-offset problem, not the generic 'invalid zone' message, when an install already saved one", async () => {
    settingsStore.set("schedulerTimezone", "-05:00");
    const scheduler = makeScheduler();
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const resolved = await scheduler.resolveTimezone();

    expect(resolved).toBe(processDefault);
    expect(scheduler.timezoneFallback).toEqual({
      configured: "-05:00",
      effective: processDefault,
    });
    expect(logError).toHaveBeenCalledWith(
      expect.stringMatching(/fixed UTC offset, not a real timezone/i),
    );
    expect(logError).not.toHaveBeenCalledWith(
      expect.stringMatching(/deprecated name|restored from a different machine/i),
    );
  });
});

describe("Scheduler timezone: ALL THREE schedule kinds resolve to the SAME zone", () => {
  it("a user task, the backup job, and AUTO_RESTART_CRON all receive the identical effectiveTimezone", async () => {
    const originalEnv = { ...process.env };
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 */6 * * *";

    try {
      const scheduler = makeScheduler();
      await scheduler.resolveTimezone();
      scheduler.setBackupService({
        getSettings: vi.fn(async () => ({ enabled: true, schedule: "0 */12 * * *", includeDb: false })),
        createBackup: vi.fn(),
      });

      const scheduledOk = scheduler.scheduleTask({
        id: 42,
        name: "Task",
        cron_expression: "0 4 * * *",
        command: "save",
      });
      expect(scheduledOk).not.toBe(false);
      scheduler.setupAutoRestart();
      await scheduler.setupBackupSchedule();

      const taskZone = scheduler.jobs.get(42).timeMatcher.timezone;
      const backupZone = scheduler.backupJob.timeMatcher.timezone;
      const autoRestartZone = scheduler.autoRestartJob.timeMatcher.timezone;

      expect(taskZone).toBe(scheduler.effectiveTimezone);
      expect(backupZone).toBe(scheduler.effectiveTimezone);
      expect(autoRestartZone).toBe(scheduler.effectiveTimezone);

      scheduler.jobs.get(42).stop();
      scheduler.backupJob.stop();
      scheduler.autoRestartJob.stop();
    } finally {
      process.env = originalEnv;
    }
  });
});

describe("Scheduler.setTimezone(): changing the zone reschedules everything immediately, not just future task creations", () => {
  it("re-registers an already-enabled task, the backup job, and auto-restart under the new zone", async () => {
    const originalEnv = { ...process.env };
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 */6 * * *";

    getScheduledTasks.mockResolvedValueOnce([
      { id: 99, name: "Existing task", cron_expression: "0 5 * * *", command: "save", enabled: 1 },
    ]);

    try {
      const scheduler = makeScheduler();
      await scheduler.resolveTimezone();
      scheduler.setBackupService({
        getSettings: vi.fn(async () => ({ enabled: true, schedule: "0 */12 * * *", includeDb: false })),
        createBackup: vi.fn(),
      });
      scheduler.setupAutoRestart();
      await scheduler.setupBackupSchedule();

      await scheduler.setTimezone("Asia/Tokyo");

      expect(scheduler.effectiveTimezone).toBe("Asia/Tokyo");
      expect(scheduler.jobs.get(99).timeMatcher.timezone).toBe("Asia/Tokyo");
      expect(scheduler.backupJob.timeMatcher.timezone).toBe("Asia/Tokyo");
      expect(scheduler.autoRestartJob.timeMatcher.timezone).toBe("Asia/Tokyo");

      scheduler.jobs.get(99).stop();
      scheduler.backupJob.stop();
      scheduler.autoRestartJob.stop();
    } finally {
      process.env = originalEnv;
    }
  });
});

import { requireServerId } from "../utils/serverScope.ts";
import cron from "node-cron";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("Scheduler");
import { type LifecycleLock } from "./lifecycleCoordinator.ts";
import { type ServerMaintenance } from "./serverMaintenance.ts";
import {
  getScheduledTasks,
  updateTaskLastRun,
  logServerEvent,
  logScheduleExecution,
  getSetting,
  setSetting,
} from "../database/init.ts";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
  isValidIanaTimezone,
  isRawOffsetTimezone,
  dstFallBackWarning,
} from "../utils/cronValidation.ts";
import {
  defaultRestartWarningSettings,
  formatRestartWarning,
  getRestartWarningPresetTemplates,
  normalizeRestartWarningSettings,
  RESTART_WARNING_SETTING_KEY,
  validateRestartWarningSettings,
} from "../utils/restartWarning.ts";
import {
  classifyScheduledCommand,
  isSchedulableCommand,
} from "../utils/schedulerCommands.ts";
export { classifyScheduledCommand } from "../utils/schedulerCommands.ts";

const SCHEDULER_TIMEZONE_SETTING_KEY = "schedulerTimezone";
type ScheduledTask = Record<string, any>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordServerEvent(
  eventType: string,
  message?: unknown | null,
): Promise<unknown> {
  return (logServerEvent as unknown as (
    eventType: string,
    message?: unknown | null,
  ) => Promise<unknown>)(eventType, message);
}

function recordScheduleExecution(
  taskId: string | number | null,
  taskName: string,
  command: string,
  success: boolean,
  message: string,
  duration: number,
): Promise<unknown> {
  return (logScheduleExecution as unknown as (
    taskId: string | number | null,
    taskName: string,
    command: string,
    success: boolean,
    message: string,
    duration: number,
  ) => Promise<unknown>)(taskId, taskName, command, success, message, duration);
}

function recordMissedExecution(
  taskId: string | number | null,
  label: string,
  command: string,
  context: any,
): void {
  const missedAt =
    context?.dateLocalIso ||
    (context?.date instanceof Date
      ? context.date.toISOString()
      : String(context?.date ?? "an unknown time"));
  log.warn(
    `Scheduled ${label ? `"${label}"` : "task"} (${command}) missed its run at ${missedAt} -- the panel likely was not running or was blocked at that moment`,
  );
  void recordScheduleExecution(
    taskId,
    label,
    command,
    false,
    `Missed scheduled run at ${missedAt} -- the panel was not running or was blocked at that moment`,
    0,
  ).catch((error: unknown) => {
    log.debug(`Could not record missed-execution history: ${errorMessage(error)}`);
  });
}

export class Scheduler {
  rconService: any;
  serverManager: any;
  backupService: any;
  io: any;
  jobs: Map<any, any>;
  jobLabels: Map<any, string>;
  autoRestartJob: any;
  backupJob: any;
  runningTasks: Set<any>;
  effectiveTimezone: string;
  configuredTimezone: string | null;
  timezoneFallback: Record<string, string> | null;
  restartWarning: any;

  readonly maintenance: ServerMaintenance;
  constructor(rconService: any, serverManager: any, maintenance: ServerMaintenance) {
    this.maintenance = maintenance;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.backupService = null;
    this.io = null;
    this.jobs = new Map();
    this.jobLabels = new Map();
    this.autoRestartJob = null;
    this.backupJob = null;
    this.runningTasks = new Set();
    this.effectiveTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.configuredTimezone = null;
    this.timezoneFallback = null;
    this.restartWarning = defaultRestartWarningSettings();
  }

  setBackupService(backupService: any): void {
    this.backupService = backupService;
  }

  setIo(io: any): void {
    this.io = io;
  }

  async resolveTimezone(): Promise<string> {
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let stored = await getSetting(SCHEDULER_TIMEZONE_SETTING_KEY);

    if (stored == null) {
      stored = processDefault;
      try {
        await setSetting(SCHEDULER_TIMEZONE_SETTING_KEY, stored);
        log.info(
          `Scheduler timezone was not previously configured -- initialized to the currently-effective zone (${stored}) so upgrading does not move any existing schedule's real fire time`,
        );
      } catch (error: unknown) {
        log.warn(`Could not persist the migrated scheduler timezone: ${errorMessage(error)}`);
      }
    }

    this.configuredTimezone = stored;

    if (!isValidIanaTimezone(stored)) {
      log.error(
        isRawOffsetTimezone(stored)
          ? `Configured scheduler timezone "${stored}" is a fixed UTC offset, not a real timezone -- it never observes daylight saving, so every schedule on this install has been silently drifting by an hour from the operator's actual local time across each DST transition. Falling back to ${processDefault} so schedules keep firing. Pick a real zone (e.g. "America/New_York") in Scheduler settings.`
          : `Configured scheduler timezone "${stored}" is not a valid IANA zone (tzdata may have removed a deprecated name, or this database was restored from a different machine) -- falling back to ${processDefault} so schedules keep firing. Fix this in Scheduler settings.`,
      );
      this.timezoneFallback = { configured: stored, effective: processDefault };
      this.effectiveTimezone = processDefault;
      return this.effectiveTimezone;
    }

    this.timezoneFallback = null;
    this.effectiveTimezone = stored;
    return this.effectiveTimezone;
  }

  async setTimezone(newZone: string): Promise<any> {
    if (!isValidIanaTimezone(newZone)) {
      const error = new Error(`"${newZone}" is not a valid IANA timezone`) as Error & {
        code?: string;
      };
      error.code = "SCHEDULER_INVALID_TIMEZONE";
      throw error;
    }

    await setSetting(SCHEDULER_TIMEZONE_SETTING_KEY, newZone);
    await this.resolveTimezone();

    const tasks = await getScheduledTasks();
    for (const task of tasks as ScheduledTask[]) {
      if (task.enabled) this.scheduleTask(task);
    }
    this.setupAutoRestart();
    await this.setupBackupSchedule();

    log.info(`Scheduler timezone changed to ${this.effectiveTimezone} -- rescheduled ${(tasks as ScheduledTask[]).filter((t) => t.enabled).length} task(s), auto-restart, and the backup job`);
    return this.getStatus();
  }

  async loadRestartWarningSettings(): Promise<any> {
    try {
      this.restartWarning = normalizeRestartWarningSettings(
        await getSetting(RESTART_WARNING_SETTING_KEY),
      );
    } catch (error: unknown) {
      this.restartWarning = defaultRestartWarningSettings();
      log.warn(`Could not load restart warning settings: ${errorMessage(error)}`);
    }
    return this.restartWarning;
  }

  async setRestartWarning(settings: any): Promise<any> {
    const normalized = validateRestartWarningSettings(settings);
    await setSetting(RESTART_WARNING_SETTING_KEY, normalized);
    this.restartWarning = normalized;
    return this.restartWarning;
  }

  async init(): Promise<void> {
    await this.resolveTimezone();
    await this.loadRestartWarningSettings();

    await this.loadScheduledTasks();

    this.setupAutoRestart();

    await this.setupBackupSchedule();

    log.info(`Scheduler initialized (timezone: ${this.effectiveTimezone})`);
  }

  async loadScheduledTasks(): Promise<void> {
    try {
      const tasks = await getScheduledTasks();

      if (!tasks || !Array.isArray(tasks)) {
        log.info("No scheduled tasks found");
        return;
      }

      for (const task of tasks) {
        if (task.enabled) {
          const scheduled = this.scheduleTask(task);
          if (!scheduled) {
            log.warn(
              `Failed to schedule task ${task.id} (${task.name}) - see previous errors`,
            );
          }
        }
      }

      log.info(`Loaded ${tasks.length} scheduled tasks`);
    } catch (error: unknown) {
      log.error(`Failed to load scheduled tasks: ${errorMessage(error)}`);
    }
  }

  scheduleTask(task: ScheduledTask): false | { scheduled: true; dstWarning?: string | null } {
    if (!isSchedulableCommand(task.command)) {
      log.warn(`Skipping unsupported scheduled command for task ${task.id} (${task.name})`);
      return false;
    }
    if (
      !isSupportedFiveFieldCron(task.cron_expression) ||
      isCronTooFrequent(task.cron_expression)
    ) {
      log.error(
        `Invalid cron expression for task ${task.id} (${task.name}): ${task.cron_expression}`,
      );
      return false;
    }

    if (this.jobs.has(task.id)) {
      this.jobs.get(task.id).stop();
    }

    const job = cron.schedule(task.cron_expression, () => this.runTaskNow(task), {
      timezone: this.effectiveTimezone,
    });
    job.on("execution:missed", (context: any) =>
      recordMissedExecution(
        task.id,
        task.name || task.command || "task",
        task.command,
        context,
      ),
    );

    this.jobs.set(task.id, job);
    this.jobLabels.set(task.id, task.name || task.command || "task");
    log.info(`Scheduled task: ${task.name} (${task.cron_expression})`);

    const dstWarning = dstFallBackWarning(
      task.cron_expression,
      this.effectiveTimezone,
      task.name,
    );
    if (dstWarning) log.warn(dstWarning);
    return { scheduled: true, dstWarning };
  }

  async runTaskNow(task: ScheduledTask): Promise<{ success: boolean; message: string }> {
    if (this.runningTasks.has(task.id)) {
      log.debug(
        `Skipping duplicate execution of task ${task.name} (already running)`,
      );
      return { success: false, message: "Already running" };
    }

    this.runningTasks.add(task.id);
    log.info(`Executing scheduled task: ${task.name}`);
    const startTime = Date.now();
    try {
      await this.executeTask(task);
      const duration = Date.now() - startTime;
      await updateTaskLastRun(task.id);
      const message = "Completed successfully";
      await recordScheduleExecution(
        task.id,
        task.name,
        task.command,
        true,
        message,
        duration,
      );
      await recordServerEvent("scheduled_task", `Executed: ${task.name}`);
      return { success: true, message };
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      log.error(`Scheduled task failed ${task.name}: ${errorMessage(error)}`);
      await recordScheduleExecution(
        task.id,
        task.name,
        task.command,
        false,
        errorMessage(error),
        duration,
      );
      await recordServerEvent(
        "scheduled_task_error",
        `${task.name}: ${errorMessage(error)}`,
      );
      return { success: false, message: errorMessage(error) };
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  getNextRun(): { label: string; at: string } | null {
    const candidates: Array<{ label: string; at: Date }> = [];
    const push = (job: any, label: string): void => {
      if (!job || typeof job.getNextRun !== "function") return;
      try {
        const at = job.getNextRun();
        if (at instanceof Date && Number.isFinite(at.getTime())) {
          candidates.push({ label, at });
        }
      } catch {
        /* a job with no computable next run simply does not compete */
      }
    };

    for (const [id, job] of this.jobs) {
      push(job, this.jobLabels.get(id) || "task");
    }
    push(this.autoRestartJob, "auto restart");
    push(this.backupJob, "backup");

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      label: candidates[0].label,
      at: candidates[0].at.toISOString(),
    };
  }

  async executeTask(task: ScheduledTask): Promise<void> {
    const commandKind = classifyScheduledCommand(task.command);
    if (commandKind === "unsupported") {
      throw new Error("Unsupported scheduled task command");
    }

    const { rconService, serverManager } =
      await this._resolveServicesForTask(task);

    try {
      if (commandKind === "restart") {
        const result = await this.performRestart(null, {
          rconService,
          serverManager,
          onlyWhenEmpty: true,
        });
        if (!result?.success) {
          throw new Error(result?.message || "Restart failed");
        }
      } else if (commandKind === "save") {
        const saved = await rconService.save({ skipLog: true });
        if (!saved?.success) {
          throw new Error(`Save failed: ${saved?.error || "unknown error"}`);
        }
      } else if (commandKind === "servermsg") {
        const message = task.command.substring(10);
        const sent = await rconService.serverMessage(message, {
          skipLog: true,
        });
        if (!sent?.success) {
          throw new Error(
            `Broadcast failed: ${sent?.error || "unknown error"}`,
          );
        }
      } else {
        const result = await rconService.execute(task.command, {
          skipLog: true,
        });
        if (!result?.success) {
          throw new Error(result?.error || "RCON command failed");
        }
      }
    } finally {
      // The profile runtime owns its connections across scheduled tasks.
    }
  }

  async _resolveServicesForTask(task: ScheduledTask) {
    if (String(task.server_id) !== requireServerId()) throw new Error("Scheduled task belongs to another server");
    return { rconService: this.rconService, serverManager: this.serverManager, cleanup: null };
  }

  cancelTask(taskId: string | number): boolean {
    if (this.jobs.has(taskId)) {
      this.jobs.get(taskId).stop();
      this.jobs.delete(taskId);
      this.jobLabels.delete(taskId);
      log.info(`Cancelled scheduled task: ${taskId}`);
      return true;
    }
    return false;
  }

  get restartInProgress(): boolean { return this.maintenance.active?.kind === "restart" || this.maintenance.active?.kind === "workshop"; }

  cancelRestart(): { success: boolean; message: string } {
    const success = this.maintenance.cancel("restart") || this.maintenance.cancel("workshop");
    return { success, message: success ? "Restart cancellation requested" : "No cancellable restart in progress" };
  }

  stopAllJobs(): void {
    for (const [taskId, job] of this.jobs) {
      job.stop();
      log.debug(`Stopped scheduled task: ${taskId}`);
    }
    this.jobs.clear();
    this.jobLabels.clear();

    if (this.autoRestartJob) {
      this.autoRestartJob.stop();
      this.autoRestartJob = null;
    }

    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    log.info("All scheduled jobs stopped");
  }

  async setupBackupSchedule(): Promise<void> {
    this.backupJob?.stop(); this.backupJob = null;
    if (!this.backupService) return;
    const settings = await this.backupService.getSettings();
    if (!settings.enabled) return;
    if (!isSupportedFiveFieldCron(settings.schedule) || isCronTooFrequent(settings.schedule)) {
      log.error(`Invalid backup schedule: ${settings.schedule}`); return;
    }
    this.backupJob = cron.schedule(settings.schedule, async () => {
      const started = Date.now();
      try {
        const result = await this.backupService.createBackup({ scheduled: true, io: this.io });
        await recordScheduleExecution(null, "Scheduled Backup", "backup", result.success,
          result.success ? `Created: ${result.backup.name}${result.skippedFiles?.length ? `; files not included (temporary files or symbolic links): ${result.skippedFiles.join(", ")}` : ""}` : result.message, Date.now() - started);
      } catch (error) { log.error(`Scheduled backup failed: ${errorMessage(error)}`); }
    }, { timezone: this.effectiveTimezone });
    this.backupJob.on("execution:missed", (context: any) => recordMissedExecution(null, "Scheduled Backup", "backup", context));
    const warning = dstFallBackWarning(settings.schedule, this.effectiveTimezone, "backup");
    if (warning) log.warn(warning);
  }

  setupAutoRestart(): void {
    const enabled = process.env.AUTO_RESTART_ENABLED === "true";
    const cronExpression = process.env.AUTO_RESTART_CRON || "0 */6 * * *";
    if (this.autoRestartJob) this.autoRestartJob.stop();
    this.autoRestartJob = null;
    if (!enabled) {
      log.info("Auto-restart is disabled");
      return;
    }

    if (
      !isSupportedFiveFieldCron(cronExpression) ||
      isCronTooFrequent(cronExpression)
    ) {
      log.error(`Invalid auto-restart cron expression: ${cronExpression}`);
      return;
    }

    const runAutoRestart = async () => {
          log.info("Executing scheduled auto-restart");
      try {
        const result = await this.performRestart(null, { onlyWhenEmpty: true });
        if (!result?.success) {
          const message = `Scheduled auto-restart did not complete: ${result?.message || "unknown error"}`;
          if (result?.deferred) log.info(message);
          else log.error(message);
        }
      } catch (err: unknown) {
        log.error(`Auto-restart cron tick failed: ${errorMessage(err)}`);
      }
    };
    this.autoRestartJob = cron.schedule(cronExpression, runAutoRestart, { timezone: this.effectiveTimezone });
    this.autoRestartJob.on("execution:missed", (context: any) =>
      recordMissedExecution(null, "Auto Restart", "restart", context),
    );

    log.info(`Auto-restart scheduled: ${cronExpression} (timezone: ${this.effectiveTimezone})`);

    const dstWarning = dstFallBackWarning(
      cronExpression,
      this.effectiveTimezone,
      "auto restart",
    );
    if (dstWarning) log.warn(dstWarning);
  }

  async performRestart(warningMinutes: number | null = null, options: {
    rconService?: any; serverManager?: any; label?: string; onlyWhenEmpty?: boolean;
    lifecycleLock?: LifecycleLock | null;
  } = {}): Promise<any> {
    if (options.rconService && options.rconService !== this.rconService || options.serverManager && options.serverManager !== this.serverManager) {
      throw new Error("Restart target does not match the bound server runtime");
    }
    const started = Date.now();
    const label = options.label || "Restart";
    const result = await this.maintenance.run({ kind: "restart", label,
      automatic: options.onlyWhenEmpty === true,
      warningMinutes: warningMinutes ?? (parseInt(process.env.RESTART_WARNING_MINUTES || "", 10) || 5),
      lifecycleLock: options.lifecycleLock,
      notice: (count, unit) => formatRestartWarning(this.restartWarning, count, unit === "minutes" ? "minute" : "second"),
    });
    await recordScheduleExecution(null, label, "restart", result.success, result.message || label, Date.now() - started);
    await recordServerEvent(result.success ? "auto_restart" : "auto_restart_error", result.message || label);
    return result;
  }

  getStatus(): Record<string, any> {
    const tasks: Array<{ id: any; running: true }> = [];
    for (const [id] of this.jobs) {
      tasks.push({ id, running: true });
    }

    return {
      activeTasks: tasks.length,
      autoRestartEnabled: !!this.autoRestartJob,
      backupScheduleEnabled: !!this.backupJob,
      maintenance: this.maintenance.active,
      nextRun: this.getNextRun(),
      timezone: this.effectiveTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      configuredTimezone: this.configuredTimezone,
      timezoneFallback: this.timezoneFallback,
      restartWarning: normalizeRestartWarningSettings(this.restartWarning),
      restartWarningPresets: getRestartWarningPresetTemplates(),
    };
  }

  shutdown(): void {
    this.stopAllJobs();

    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    log.info("Scheduler shutdown complete");
  }
}

import fs from "fs";
import path from "path";
import cron from "node-cron";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Scheduler");
import panelBridge from "./panelBridge.js";
import { RconService } from "./rcon.js";
import { ServerManager } from "./serverManager.js";
import { runManagedLifecycle } from "./managedContainer.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.ts";
import { createBackupIfChanged } from "../utils/configBackup.js";
import {
  candidateIniPaths,
  refreshLaunchTargetBeforeStart,
} from "../routes/server.js";
import {
  getScheduledTasks,
  updateTaskLastRun,
  logServerEvent,
  logScheduleExecution,
  getActiveServer,
  getServer,
  getSetting,
  setSetting,
} from "../database/init.js";
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
  getRestartWarningNotice,
  getRestartWarningPresetTemplates,
  normalizeRestartWarningSettings,
  RESTART_WARNING_SETTING_KEY,
  validateRestartWarningSettings,
} from "../utils/restartWarning.js";

const SCHEDULER_TIMEZONE_SETTING_KEY = "schedulerTimezone";
const SCHEDULABLE_BRIDGE_ACTIONS = new Set([
  "triggerBlizzard",
  "triggerTropicalStorm",
  "triggerStorm",
  "stopWeather",
  "startRain",
  "stopRain",
  "setSnow",
  "triggerLightning",
  "triggerGunshot",
  "triggerAlarmSound",
  "restoreUtilities",
  "shutOffUtilities",
  "saveWorld",
  "sendToServerChat",
  "sendToAdminChat",
]);

export function classifyScheduledCommand(command) {
  const commandLower = String(command ?? "").toLowerCase();
  if (commandLower === "restart") return "restart";
  if (commandLower === "save") return "save";
  if (commandLower.startsWith("servermsg ")) return "servermsg";
  if (commandLower.startsWith("bridge:")) return "bridge";
  return "raw";
}

function parseBridgeActionName(rawCommand) {
  const body = rawCommand.slice("bridge:".length).trim();
  const firstSpace = body.indexOf(" ");
  return (firstSpace === -1 ? body : body.slice(0, firstSpace)).trim();
}

const ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS = new Set([
  "triggerGunshot",
  "triggerAlarmSound",
  "sendToAdminChat",
]);

export function requiredCapabilityForScheduledCommand(command) {
  const kind = classifyScheduledCommand(command);
  if (kind === "restart" || kind === "save") return "server.control";
  if (kind === "servermsg") return "server.world_events";
  if (kind === "bridge") {
    const action = parseBridgeActionName(String(command ?? ""));
    if (action === "saveWorld") return "server.control";
    if (ENDANGER_OR_IMPERSONATE_BRIDGE_ACTIONS.has(action)) {
      return "players.endanger_or_impersonate";
    }
    return "server.world_events";
  }
  return "rcon.execute";
}

export class Scheduler {
  constructor(rconService, serverManager) {
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.backupService = null;
    this.discordBot = null;
    this.io = null;
    this.jobs = new Map();
    this.jobLabels = new Map();
    this.autoRestartJob = null;
    this.backupJob = null;
    this.modUpdateRestartPending = false;
    this.restartInProgress = false;
    this.runningTasks = new Set();
    this.effectiveTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.configuredTimezone = null;
    this.timezoneFallback = null;
    this.restartWarning = defaultRestartWarningSettings();
  }

  setBackupService(backupService) {
    this.backupService = backupService;
  }

  setDiscordBot(discordBot) {
    this.discordBot = discordBot;
  }

  setIo(io) {
    this.io = io;
  }

  _emitVerifiedTransition(running) {
    if (typeof this.io?.emit === "function") {
      this.io.emit("server:status", { running });
    }
  }

  async resolveTimezone() {
    const processDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let stored = await getSetting(SCHEDULER_TIMEZONE_SETTING_KEY);

    if (stored == null) {
      stored = processDefault;
      try {
        await setSetting(SCHEDULER_TIMEZONE_SETTING_KEY, stored);
        log.info(
          `Scheduler timezone was not previously configured -- initialized to the currently-effective zone (${stored}) so upgrading does not move any existing schedule's real fire time`,
        );
      } catch (error) {
        log.warn(`Could not persist the migrated scheduler timezone: ${error.message}`);
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

  async setTimezone(newZone) {
    if (!isValidIanaTimezone(newZone)) {
      const error = new Error(`"${newZone}" is not a valid IANA timezone`);
      error.code = "SCHEDULER_INVALID_TIMEZONE";
      throw error;
    }

    await setSetting(SCHEDULER_TIMEZONE_SETTING_KEY, newZone);
    await this.resolveTimezone();

    const tasks = await getScheduledTasks();
    for (const task of tasks) {
      if (task.enabled) this.scheduleTask(task);
    }
    this.setupAutoRestart();
    await this.setupBackupSchedule();

    log.info(`Scheduler timezone changed to ${this.effectiveTimezone} -- rescheduled ${tasks.filter((t) => t.enabled).length} task(s), auto-restart, and the backup job`);
    return this.getStatus();
  }

  async loadRestartWarningSettings() {
    try {
      this.restartWarning = normalizeRestartWarningSettings(
        await getSetting(RESTART_WARNING_SETTING_KEY),
      );
    } catch (error) {
      this.restartWarning = defaultRestartWarningSettings();
      log.warn(`Could not load restart warning settings: ${error.message}`);
    }
    return this.restartWarning;
  }

  async setRestartWarning(settings) {
    const normalized = validateRestartWarningSettings(settings);
    await setSetting(RESTART_WARNING_SETTING_KEY, normalized);
    this.restartWarning = normalized;
    return this.restartWarning;
  }

  async init() {
    await this.resolveTimezone();
    await this.loadRestartWarningSettings();

    await this.loadScheduledTasks();

    this.setupAutoRestart();

    await this.setupBackupSchedule();

    log.info(`Scheduler initialized (timezone: ${this.effectiveTimezone})`);
  }

  async loadScheduledTasks() {
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
    } catch (error) {
      log.error(`Failed to load scheduled tasks: ${error.message}`);
    }
  }

  scheduleTask(task) {
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

  async runTaskNow(task) {
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
      await logScheduleExecution(
        task.id,
        task.name,
        task.command,
        true,
        message,
        duration,
      );
      await logServerEvent("scheduled_task", `Executed: ${task.name}`);
      return { success: true, message };
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`Scheduled task failed ${task.name}: ${error.message}`);
      await logScheduleExecution(
        task.id,
        task.name,
        task.command,
        false,
        error.message,
        duration,
      );
      await logServerEvent(
        "scheduled_task_error",
        `${task.name}: ${error.message}`,
      );
      return { success: false, message: error.message };
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  getNextRun() {
    const candidates = [];
    const push = (job, label) => {
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
    candidates.sort((a, b) => a.at - b.at);
    return {
      label: candidates[0].label,
      at: candidates[0].at.toISOString(),
    };
  }

  async executeTask(task) {
    const commandKind = classifyScheduledCommand(task.command);

    const { rconService, serverManager, cleanup } =
      await this._resolveServicesForTask(task);

    try {
      if (commandKind === "restart") {
        const result = await this.performRestart(null, {
          rconService,
          serverManager,
        });
        if (
          !result.success &&
          result.message === "Restart already in progress"
        ) {
          throw new Error("Restart skipped - already in progress");
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
      } else if (commandKind === "bridge") {
        if (cleanup) {
          throw new Error(
            "bridge: actions only support the currently active server " +
              "(PanelBridge has no per-server instancing yet) — reassign " +
              "this task or switch the active server before it fires",
          );
        }
        await this.executeBridgeAction(task.command);
      } else {
        const result = await rconService.execute(task.command, {
          skipLog: true,
        });
        if (!result?.success) {
          throw new Error(result?.error || "RCON command failed");
        }
      }
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async _ensureRestartTarget(serverManager, pinnedServerId) {
    if (pinnedServerId == null) return;

    let current = serverManager._serverId ?? null;
    if (current == null) {
      try {
        current = (await getActiveServer())?.id ?? null;
      } catch (error) {
        log.debug(`Could not verify restart target: ${error.message}`);
        return;
      }
    }
    if (String(current) === String(pinnedServerId)) return;

    log.warn(
      `Auto-restart: active server changed mid-restart — re-targeting server ${pinnedServerId} so the restart finishes on the server it began on`,
    );
    await serverManager.reloadConfig(pinnedServerId);
  }

  async _backupConfigBeforeRestart(pinnedServerId) {
    let server = null;
    try {
      server =
        pinnedServerId != null
          ? await getServer(pinnedServerId)
          : await getActiveServer();
      if (!server?.serverName) return server;

      const serverConfigPath =
        server.serverConfigPath ||
        (server.zomboidDataPath
          ? path.join(server.zomboidDataPath, "Server")
          : null);
      if (!serverConfigPath) return server;

      const iniPath =
        candidateIniPaths(
          serverConfigPath,
          server.zomboidDataPath,
          server.serverName,
        ).find((candidate) => fs.existsSync(candidate)) ||
        path.join(serverConfigPath, `${server.serverName}.ini`);

      const configDir = path.dirname(iniPath);
      const iniFilename = path.basename(iniPath);
      const sandboxFilename = iniFilename.toLowerCase().endsWith(".ini")
        ? `${iniFilename.slice(0, -4)}_SandboxVars.lua`
        : `${server.serverName}_SandboxVars.lua`;

      for (const filename of [iniFilename, sandboxFilename]) {
        const result = await createBackupIfChanged(configDir, filename);
        if (result.reason === "failed") {
          log.warn(
            `Pre-restart config backup of ${filename} failed: ${result.error}`,
          );
        }
      }
    } catch (error) {
      log.warn(`Pre-restart config backup failed: ${error.message}`);
    }
    return server;
  }

  async _resolveServicesForTask(task) {
    const shared = {
      rconService: this.rconService,
      serverManager: this.serverManager,
      cleanup: null,
    };

    if (!task.server_id) return shared;

    let active;
    try {
      active = await getActiveServer();
    } catch (error) {
      log.warn(
        `Could not resolve active server for task ${task.name}, using shared connection: ${error.message}`,
      );
      return shared;
    }

    if (active && String(active.id) === String(task.server_id)) {
      return shared;
    }

    log.info(
      `Task "${task.name}" targets server ${task.server_id}, which isn't active — using a temporary connection`,
    );
    const tempRcon = new RconService();
    const tempManager = new ServerManager();
    await tempRcon.loadConfig(task.server_id);
    await tempManager.loadConfig(task.server_id);

    return {
      rconService: tempRcon,
      serverManager: tempManager,
      cleanup: async () => {
        try {
          if (tempRcon.connected) await tempRcon.disconnect();
        } catch (error) {
          log.debug(`Cleanup: failed to disconnect temp RCON: ${error.message}`);
        }
      },
    };
  }

  async executeBridgeAction(rawCommand) {
    const body = rawCommand.slice("bridge:".length).trim();
    if (!body) throw new Error("bridge: action missing");

    const action = parseBridgeActionName(rawCommand);
    const firstSpace = body.indexOf(" ");
    const argsRaw = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();

    if (!SCHEDULABLE_BRIDGE_ACTIONS.has(action)) {
      throw new Error(
        `bridge action '${action}' is not allowed in scheduled tasks`,
      );
    }

    let args = {};
    if (argsRaw) {
      try {
        args = JSON.parse(argsRaw);
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          throw new Error("args must be a JSON object");
        }
      } catch (err) {
        throw new Error(`invalid bridge args JSON: ${err.message}`);
      }
    }

    return panelBridge.sendCommand(action, args);
  }

  cancelTask(taskId) {
    if (this.jobs.has(taskId)) {
      this.jobs.get(taskId).stop();
      this.jobs.delete(taskId);
      this.jobLabels.delete(taskId);
      log.info(`Cancelled scheduled task: ${taskId}`);
      return true;
    }
    return false;
  }

  cancelRestart() {
    if (this.restartInProgress) {
      this.restartCancelled = true;
      log.info("Restart cancellation requested");
      return { success: true, message: "Restart cancellation requested" };
    }
    return { success: false, message: "No restart in progress" };
  }

  stopAllJobs() {
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

  async setupBackupSchedule() {
    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    if (!this.backupService) {
      log.debug("Backup service not available");
      return;
    }

    try {
      const settings = await this.backupService.getSettings();

      if (!settings.enabled) {
        log.info("Scheduled backups are disabled");
        return;
      }

      if (
        !isSupportedFiveFieldCron(settings.schedule) ||
        isCronTooFrequent(settings.schedule)
      ) {
        log.error(
          `Invalid backup schedule cron expression: ${settings.schedule}`,
        );
        return;
      }

      this.backupJob = cron.schedule(settings.schedule, async () => {
        if (this.restartInProgress) {
          log.warn(
            "Scheduled backup skipped: a restart is currently in progress (would risk archiving a save mid-write)",
          );
          await logScheduleExecution(
            null,
            "Scheduled Backup",
            "backup",
            false,
            "Skipped: a restart was in progress",
            0,
          );
          return;
        }
        log.info("Executing scheduled backup");
        const startTime = Date.now();
        try {
          const result = await this.backupService.createBackup({
            includeDb: settings.includeDb,
          });
          const duration = Date.now() - startTime;
          if (result.success) {
            const skipNote = result.skippedFiles?.length
              ? ` (${result.skippedFiles.length} file(s) not included -- a temp/log/lock file rewritten mid-backup, or a symbolic link deliberately not followed: ${result.skippedFiles.join(", ")})`
              : "";
            await logScheduleExecution(
              null,
              "Scheduled Backup",
              "backup",
              true,
              `Created: ${result.backup.name}${skipNote}`,
              duration,
            );
            log.info(`Scheduled backup completed: ${result.backup.name}${skipNote}`);
          } else {
            await logScheduleExecution(
              null,
              "Scheduled Backup",
              "backup",
              false,
              result.message,
              duration,
            );
            log.error(`Scheduled backup failed: ${result.message}`);
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          await logScheduleExecution(
            null,
            "Scheduled Backup",
            "backup",
            false,
            error.message,
            duration,
          );
          log.error(`Scheduled backup error: ${error.message}`);
        }
      }, { timezone: this.effectiveTimezone });

      log.info(`Backup schedule configured: ${settings.schedule} (timezone: ${this.effectiveTimezone})`);

      const dstWarning = dstFallBackWarning(
        settings.schedule,
        this.effectiveTimezone,
        "backup",
      );
      if (dstWarning) log.warn(dstWarning);
    } catch (error) {
      log.error(`Failed to setup backup schedule: ${error.message}`);
    }
  }

  setupAutoRestart() {
    const enabled = process.env.AUTO_RESTART_ENABLED === "true";
    const cronExpression = process.env.AUTO_RESTART_CRON || "0 */6 * * *";
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

    if (this.autoRestartJob) {
      this.autoRestartJob.stop();
      this.autoRestartJob = null;
    }

    this.autoRestartJob = cron.schedule(cronExpression, async () => {
      log.info("Executing scheduled auto-restart");
      try {
        const result = await this.performRestart();
        if (!result?.success) {
          log.error(
            `Scheduled auto-restart did not complete: ${result?.message || "unknown error"}`,
          );
        }
      } catch (err) {
        log.error(`Auto-restart cron tick failed: ${err.message}`);
      }
    }, { timezone: this.effectiveTimezone });

    log.info(`Auto-restart scheduled: ${cronExpression} (timezone: ${this.effectiveTimezone})`);

    const dstWarning = dstFallBackWarning(
      cronExpression,
      this.effectiveTimezone,
      "auto restart",
    );
    if (dstWarning) log.warn(dstWarning);
  }

  async _broadcastRestartMessage(text, rconService = this.rconService) {
    try {
      const r = await rconService.serverMessage(text, { skipLog: true });
      if (!r?.success) {
        log.warn(
          `Restart broadcast (RCON) failed: ${r?.error || r?.response || "unknown"}`,
        );
      }
    } catch (err) {
      log.warn(`Restart broadcast (RCON) threw: ${err.message}`);
    }

    if (rconService !== this.rconService) return;
    try {
      if (
        panelBridge &&
        typeof panelBridge.isModConnected === "function" &&
        panelBridge.isModConnected()
      ) {
        panelBridge
          .sendCommand("sendToServerChat", { message: text, isAlert: true })
          .catch((err) => {
            log.debug(`Restart broadcast (bridge) failed: ${err.message}`);
          });
      }
    } catch (err) {
      log.debug(`Restart broadcast (bridge) threw: ${err.message}`);
    }
  }

  async _notifyRestartCancelled() {
    if (!this.discordBot) return;
    try {
      await this.discordBot.sendNotification(
        "✅ **Scheduled restart cancelled** — the server is staying up.",
      );
    } catch (err) {
      log.debug(`Discord restart-cancelled notification failed: ${err.message}`);
    }
  }

  async performRestart(
    warningMinutesParam = null,
    {
      rconService = this.rconService,
      serverManager = this.serverManager,
      label = "Auto Restart",
      lifecycleLock: providedLifecycleLock = null,
    } = {},
  ) {
    if (this.restartInProgress) {
      log.info("Restart already in progress, ignoring duplicate request");
      return { success: false, message: "Restart already in progress" };
    }

    const lifecycleLock =
      providedLifecycleLock ||
      acquireLifecycleLock("restart", serverManager?.serverName || null);
    if (!lifecycleLock) {
      return { success: false, ...lifecycleInProgressResponse() };
    }

    this.restartInProgress = true;
    this.restartCancelled = false;
    const warningMinutes =
      warningMinutesParam ??
      (parseInt(process.env.RESTART_WARNING_MINUTES, 10) || 5);
    const restartWarning = normalizeRestartWarningSettings(this.restartWarning);
    const restartStartTime = Date.now();

    let pinnedServerId = serverManager._serverId ?? null;
    if (pinnedServerId == null) {
      try {
        pinnedServerId = (await getActiveServer())?.id ?? null;
      } catch (error) {
        log.debug(`Could not pin restart target: ${error.message}`);
      }
    }

    try {
      const readProcessDetails = async () => {
        if (typeof serverManager.getServerProcessDetails === "function") {
          return serverManager.getServerProcessDetails();
        }
        return { running: false, scanFailed: true };
      };

      const initialProcessDetails = await readProcessDetails();
      const processScanFailed = Boolean(initialProcessDetails?.scanFailed);
      let wasRunning = Boolean(initialProcessDetails?.running);
      log.info(`Auto-restart: Process check returned: ${wasRunning}`);

      if (!wasRunning && rconService.connected) {
        log.info(
          "Auto-restart: Process check failed but RCON is connected - server IS running",
        );
        wasRunning = true;
      }

      if (!wasRunning) {
        try {
          const testResult = await rconService.execute("players", {
            skipLog: true,
          });
          if (testResult.success) {
            log.info(
              "Auto-restart: RCON command succeeded - server IS running",
            );
            wasRunning = true;
          }
        } catch (e) {
          log.debug(`Auto-restart: RCON test failed: ${e.message}`);
        }
      }

      if (!wasRunning) {
        if (processScanFailed) {
          const restartDuration = Date.now() - restartStartTime;
          const errorMsg =
            "Could not confirm whether the server is stopped because process detection failed";
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            errorMsg,
            restartDuration,
          );
          logServerEvent("auto_restart_error", errorMsg);
          return { success: false, wasRunning: false, message: errorMsg };
        }

        log.info(
          "Auto-restart triggered but server was not running - starting server",
        );
        const restartTarget = await this._backupConfigBeforeRestart(pinnedServerId);
        await refreshLaunchTargetBeforeStart(restartTarget, {
          managedHandled: false,
        });
        const started = await serverManager.startServer({
          serverId: pinnedServerId,
        });
        if (!started?.success) {
          log.warn(
            `Auto-restart: start command reported failure: ${started?.error || started?.message || "unknown error"}`,
          );
        }

        await this.sleep(10000);
        const postStartDetails = await readProcessDetails();
        const isNowRunning =
          rconService.connected ||
          Boolean(postStartDetails && !postStartDetails.scanFailed && postStartDetails.running);

        const restartDuration = Date.now() - restartStartTime;
        if (isNowRunning) {
          await logScheduleExecution(
            null,
            label,
            "restart",
            true,
            "Server was offline - started successfully",
            restartDuration,
          );
          logServerEvent(
            "auto_restart",
            "Server was offline - started successfully",
          );
          log.info("Server started successfully (was not running)");
        } else {
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            "Server was offline - failed to start",
            restartDuration,
          );
          logServerEvent(
            "auto_restart_error",
            "Server was offline - failed to start",
          );
          log.error("Failed to start server");
        }
        return { success: isNowRunning, wasRunning: false };
      }

      if (!rconService.connected) {
        log.info("Auto-restart: RCON not connected, attempting to connect...");
        try {
          await rconService.connect();
        } catch (e) {
          log.error(`Auto-restart: Failed to connect RCON: ${e.message}`);
        }
      }

      const testResult = await rconService.execute("players", {
        skipLog: true,
      });
      if (!testResult.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `RCON not available: ${testResult.error || "connection failed"}`;
        log.error(`Auto-restart failed: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
        );
        logServerEvent("auto_restart_error", errorMsg);
        return { success: false, message: errorMsg };
      }

      log.info("Auto-restart: RCON verified, sending warnings...");

      if (this.discordBot) {
        this.discordBot
          .sendEventNotification("scheduledRestart", {
            minutes: warningMinutes,
          })
          .catch((err) =>
            log.debug(
              `Discord scheduledRestart notification failed: ${err.message}`,
            ),
          );
      }

      if (warningMinutes > 0) {
        for (let i = warningMinutes; i > 0; i--) {
          if (this.restartCancelled) {
            log.info("Auto-restart: Cancelled during countdown");
            await this._broadcastRestartMessage(
              getRestartWarningNotice(restartWarning, "cancelled"),
              rconService,
            );
            await this._notifyRestartCancelled();
            return { success: false, message: "Restart cancelled" };
          }
          await this._broadcastRestartMessage(
            formatRestartWarning(restartWarning, i, "minute"),
            rconService,
          );

          if (i > 1) {
            await this.sleep(60000);
          }
        }

        const finalTicks = [
          { wait: 30000, count: 30 },
          { wait: 20000, count: 10 },
          { wait: 5000, count: 5 },
          { wait: 1000, count: 4 },
          { wait: 1000, count: 3 },
          { wait: 1000, count: 2 },
          { wait: 1000, count: 1 },
        ];
        for (const tick of finalTicks) {
          await this.sleep(tick.wait);
          if (this.restartCancelled) {
            log.info("Auto-restart: Cancelled during final countdown");
            await this._broadcastRestartMessage(
              getRestartWarningNotice(restartWarning, "cancelled"),
              rconService,
            );
            await this._notifyRestartCancelled();
            return { success: false, message: "Restart cancelled" };
          }
          await this._broadcastRestartMessage(
            formatRestartWarning(restartWarning, tick.count, "second"),
            rconService,
          );
        }

        await this.sleep(1000);
        await this._broadcastRestartMessage(
          getRestartWarningNotice(restartWarning, "restarting"),
          rconService,
        );
        await this.sleep(2000);
      } else {
        await this._broadcastRestartMessage(
          getRestartWarningNotice(restartWarning, "restarting"),
          rconService,
        );
        await this.sleep(2000);
      }

      log.info("Auto-restart: Saving world...");
      const saveResult = await rconService.save({ skipLog: true });
      if (!saveResult?.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `Save failed; restart cancelled: ${saveResult?.error || "unknown error"}`;
        log.error(`Auto-restart: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
        );
        await logServerEvent("auto_restart_error", errorMsg);
        return { success: false, wasRunning: true, message: errorMsg };
      }
      await this.sleep(3000);

      const managed = await runManagedLifecycle("restart", {
        serverId: pinnedServerId,
      });
      if (managed.handled && !managed.success) {
        const restartDuration = Date.now() - restartStartTime;
        const errorMsg = `Container restart failed: ${managed.error || "unknown error"}`;
        log.error(`Auto-restart failed: ${errorMsg}`);
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          errorMsg,
          restartDuration,
        );
        logServerEvent("auto_restart_error", errorMsg);
        return { success: false, wasRunning: true, message: errorMsg };
      }

      if (!managed.handled) {
        log.info("Auto-restart: Sending quit command...");
        const quit = await rconService.quit({ skipLog: true });
        if (!quit?.success) {
          log.warn(
            `Auto-restart: quit command failed (${quit?.error || "unknown error"}), falling back to a forced stop`,
          );
        }
        await this.sleep(10000);

        let attempts = 0;
        let processDetails = await readProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          const restartDuration = Date.now() - restartStartTime;
          const errorMsg =
            "Could not confirm the old server stopped because process detection failed";
          await logScheduleExecution(
            null,
            label,
            "restart",
            false,
            errorMsg,
            restartDuration,
          );
          logServerEvent("auto_restart_error", errorMsg);
          return { success: false, wasRunning: true, message: errorMsg };
        }
        while (processDetails.running && attempts < 60) {
          await this.sleep(1000);
          attempts++;
          processDetails = await readProcessDetails();
          if (!processDetails || processDetails.scanFailed) {
            const restartDuration = Date.now() - restartStartTime;
            const errorMsg =
              "Could not confirm the old server stopped because process detection failed";
            await logScheduleExecution(
              null,
              label,
              "restart",
              false,
              errorMsg,
              restartDuration,
            );
            logServerEvent("auto_restart_error", errorMsg);
            return { success: false, wasRunning: true, message: errorMsg };
          }
        }

        if (processDetails.running) {
          const forced = await serverManager.stopServer(false, {
            serverId: pinnedServerId,
          });
          if (!forced?.success || forced.confirmed === false) {
            const stopError =
              forced?.error || forced?.message || "unknown error";
            const restartDuration = Date.now() - restartStartTime;
            log.warn(`Auto-restart: forced stop failed: ${stopError}`);
            await logScheduleExecution(
              null,
              label,
              "restart",
              false,
              `Could not confirm the old server stopped: ${stopError}`,
              restartDuration,
            );
            logServerEvent(
              "auto_restart_error",
              `Could not confirm the old server stopped: ${stopError}`,
            );
            return {
              success: false,
              wasRunning: true,
              message: `Could not confirm the old server stopped: ${stopError}`,
            };
          }
          await this.sleep(5000);
        }

        this._emitVerifiedTransition(false);

        await this.sleep(3000);
      }

      const restartTarget = await this._backupConfigBeforeRestart(pinnedServerId);

      await refreshLaunchTargetBeforeStart(restartTarget, {
        managedHandled: managed.handled,
      });

      if (rconService.setServerStarting) {
        rconService.setServerStarting(true);
      } else {
        rconService.serverStarting = true;
      }

      let serverStarted = false;
      if (managed.handled) {
        serverStarted = true;
        log.info("Auto-restart: Managed container restarted");
      } else {
        log.info("Auto-restart: Starting server...");
        await this._ensureRestartTarget(serverManager, pinnedServerId);
        const restarted = await serverManager.startServer({
          skipRunningCheck: true,
          serverId: pinnedServerId,
        });
        if (!restarted?.success) {
          log.warn(
            `Auto-restart: start command reported failure: ${restarted?.error || restarted?.message || "unknown error"}`,
          );
        }

        for (let i = 0; i < 60; i++) {
          await this.sleep(1000);
          const processDetails = await readProcessDetails();
          if (
            rconService.connected ||
            (processDetails &&
              !processDetails.scanFailed &&
              processDetails.running)
          ) {
            serverStarted = true;
            log.info("Auto-restart: Server process detected as running");
            break;
          }
        }
      }

      if (!serverStarted) {
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        const restartDuration = Date.now() - restartStartTime;
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          "Server stopped but failed to start",
          restartDuration,
        );
        logServerEvent(
          "auto_restart_error",
          "Server stopped but failed to start",
        );
        log.error("Auto-restart: Server stopped but failed to start");
        return { success: false, wasRunning: true };
      }

      this._emitVerifiedTransition(true);

      log.info("Auto-restart: Waiting for RCON to be ready...");
      const rconDelays = [60000, 45000, 45000, 45000, 45000];
      let rconConnected = false;

      for (let i = 0; i < rconDelays.length; i++) {
        const delaySeconds = rconDelays[i] / 1000;
        log.info(
          `Auto-restart: RCON waiting ${delaySeconds}s before attempt ${i + 1}/${rconDelays.length}...`,
        );
        await this.sleep(rconDelays[i]);

        if (rconService.connected) {
          rconConnected = true;
          log.info("Auto-restart: RCON connected during wait period");
          break;
        }

        if (rconService.forceResetConnectionState) {
          rconService.forceResetConnectionState();
        }

        try {
          log.info(
            `Auto-restart: RCON attempting connection ${i + 1}/${rconDelays.length}...`,
          );
          const connectPromise = rconService.connect();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Connection attempt timed out after 15s")),
              15000,
            ),
          );

          const connectResult = await Promise.race([
            connectPromise,
            timeoutPromise,
          ]);

          if (rconService.connected) {
            rconConnected = true;
            log.info("Auto-restart: RCON connected after server startup");
            break;
          } else {
            log.info(
              `Auto-restart: RCON attempt ${i + 1} - not connected (result: ${connectResult})`,
            );
          }
        } catch (e) {
          log.info(`Auto-restart: RCON attempt ${i + 1} failed: ${e.message}`);
          if (rconService.forceResetConnectionState) {
            rconService.forceResetConnectionState();
          }
        }
        // Don't toggle serverStarting - keep it true to block auto-reconnect
      }

      if (rconConnected) {
        log.info("Auto-restart: RCON startup sequence completed - connected");
      } else {
        log.warn(
          "Auto-restart: RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)",
        );
      }

      if (rconService.setServerStarting) {
        rconService.setServerStarting(false);
      } else {
        rconService.serverStarting = false;
      }

      const restartDuration = Date.now() - restartStartTime;

      if (serverStarted) {
        const rconStatus = rconConnected
          ? " (RCON connected)"
          : " (RCON not yet connected)";
        await logScheduleExecution(
          null,
          label,
          "restart",
          true,
          "Server restarted successfully" + rconStatus,
          restartDuration,
        );
        logServerEvent(
          "auto_restart",
          "Server restarted successfully" + rconStatus,
        );
        log.info(
          `Auto-restart completed successfully (took ${Math.round(restartDuration / 1000)}s)${rconStatus}`,
        );
      } else {
        await logScheduleExecution(
          null,
          label,
          "restart",
          false,
          "Server stopped but failed to start",
          restartDuration,
        );
        logServerEvent(
          "auto_restart_error",
          "Server stopped but failed to start",
        );
        log.error("Auto-restart: Server stopped but failed to start");
      }

      return { success: serverStarted, wasRunning: true };
    } catch (error) {
      const restartDuration = Date.now() - restartStartTime;
      log.error(`Auto-restart failed: ${error.message}`);
      await logScheduleExecution(
        null,
        label,
        "restart",
        false,
        error.message,
        restartDuration,
      );
      logServerEvent("auto_restart_error", error.message);
      if (rconService.setServerStarting) {
        rconService.setServerStarting(false);
      } else {
        rconService.serverStarting = false;
      }
      throw error;
    } finally {
      this.restartInProgress = false;
      lifecycleLock.release();
    }
  }

  async triggerModUpdateRestart() {
    if (this.modUpdateRestartPending) {
      log.info("Mod update restart already pending");
      return;
    }

    this.modUpdateRestartPending = true;
    log.info("Mod update detected - scheduling restart");

    try {
      const warned = await this.rconService.serverMessage(
        "🔧 Mod updates detected! Server will restart in 5 minutes.",
      );
      if (!warned?.success) {
        log.warn(
          `Could not warn players about the mod-update restart: ${warned?.error || "unknown error"}`,
        );
      }
      const result = await this.performRestart(5);
      if (!result?.success) {
        log.error(
          `Mod-update restart did not complete: ${result?.message || "unknown error"}`,
        );
      }
      this.modUpdateRestartPending = false;
    } catch (error) {
      this.modUpdateRestartPending = false;
      throw error;
    }
  }

  getStatus() {
    const tasks = [];
    for (const [id] of this.jobs) {
      tasks.push({ id, running: true });
    }

    return {
      activeTasks: tasks.length,
      autoRestartEnabled: !!this.autoRestartJob,
      backupScheduleEnabled: !!this.backupJob,
      modUpdateRestartPending: this.modUpdateRestartPending,
      nextRun: this.getNextRun(),
      timezone: this.effectiveTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      configuredTimezone: this.configuredTimezone,
      timezoneFallback: this.timezoneFallback,
      restartWarning: normalizeRestartWarningSettings(this.restartWarning),
      restartWarningPresets: getRestartWarningPresetTemplates(),
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  shutdown() {
    this.stopAllJobs();

    if (this.backupJob) {
      this.backupJob.stop();
      this.backupJob = null;
    }

    log.info("Scheduler shutdown complete");
  }
}

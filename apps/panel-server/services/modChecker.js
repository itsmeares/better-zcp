import { createLogger } from "../utils/logger.js";
const log = createLogger("Mods");
import {
  getTrackedMods,
  updateModTimestamp,
  logServerEvent,
  getSetting,
  setSetting,
  addTrackedMod,
  getActiveServer,
  isModIgnored,
  markModsChecked,
} from "../database/init.js";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { sanitizeError } from "../utils/sanitize.js";
import panelBridge from "./panelBridge.js";

export const MOD_CHECK_INTERVAL_MINUTES_MIN = 1;
export const MOD_CHECK_INTERVAL_MINUTES_MAX = 120;
const MOD_CHECK_INTERVAL_DEFAULT_MS = 5 * 60 * 1000;

export function minutesToCheckIntervalMs(minutes) {
  const value = Number(minutes);
  if (
    !Number.isInteger(value) ||
    value < MOD_CHECK_INTERVAL_MINUTES_MIN ||
    value > MOD_CHECK_INTERVAL_MINUTES_MAX
  ) {
    return null;
  }
  return value * 60 * 1000;
}

export function getWorkshopAcfCandidates(installPath) {
  if (typeof installPath !== "string" || !installPath.trim()) return [];

  const rawPath = installPath.trim();
  const baseRoot = path.normalize(rawPath);
  const roots = [];
  const extension = path.extname(rawPath).toLowerCase();
  let currentRoot = [".bat", ".cmd", ".exe", ".sh"].includes(extension)
    ? path.dirname(baseRoot)
    : baseRoot;
  for (let depth = 0; depth < 5; depth += 1) {
    roots.push(currentRoot);
    const parentRoot = path.dirname(currentRoot);
    if (parentRoot === currentRoot) break;
    currentRoot = parentRoot;
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    const normalized = path.normalize(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };

  for (const root of roots) {
    addCandidate(
      path.join(root, "steamapps", "workshop", "appworkshop_108600.acf"),
    );
    addCandidate(path.join(root, "workshop", "appworkshop_108600.acf"));
    addCandidate(path.join(root, "appworkshop_108600.acf"));
    addCandidate(
      path.join(root, "..", "steamapps", "workshop", "appworkshop_108600.acf"),
    );
  }

  return candidates;
}

export async function refreshWorkshopChecker(modChecker) {
  if (!modChecker?.findWorkshopAcfPath) return null;

  const workshopAcfPath = await modChecker.findWorkshopAcfPath();
  if (workshopAcfPath) {
    if (!modChecker.isRunning) modChecker.start();
  } else if (modChecker.isRunning) {
    modChecker.stop();
  }
  return workshopAcfPath;
}

export function normalizeStoredCheckInterval(value) {
  const minutesInterval = minutesToCheckIntervalMs(value);
  if (minutesInterval !== null)
    return {
      intervalMs: minutesInterval,
      minutes: Number(value),
      legacy: false,
    };

  const intervalMs = Number(value);
  if (
    Number.isInteger(intervalMs) &&
    intervalMs >= MOD_CHECK_INTERVAL_MINUTES_MIN * 60 * 1000 &&
    intervalMs <= MOD_CHECK_INTERVAL_MINUTES_MAX * 60 * 1000 &&
    intervalMs % (60 * 1000) === 0
  ) {
    return { intervalMs, minutes: intervalMs / (60 * 1000), legacy: true };
  }
  return null;
}

export function parseLegacyBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

export function parseLegacyMinutes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes;
}

function parseModInfoVersionFolder(folderName) {
  if (!/^\d+(?:\.\d+)*$/.test(folderName)) return null;
  return folderName.split(".").map((part) => Number.parseInt(part, 10));
}

function compareModInfoCandidates(leftCandidate, rightCandidate) {
  const leftVersion = leftCandidate.version;
  const rightVersion = rightCandidate.version;

  if (leftVersion && !rightVersion) return -1;
  if (!leftVersion && rightVersion) return 1;

  if (leftVersion && rightVersion) {
    const maxParts = Math.max(leftVersion.length, rightVersion.length);
    for (let partIndex = 0; partIndex < maxParts; partIndex++) {
      const leftPart = leftVersion[partIndex] || 0;
      const rightPart = rightVersion[partIndex] || 0;
      if (leftPart !== rightPart) return rightPart - leftPart;
    }
  }

  return leftCandidate.order - rightCandidate.order;
}

export class ModChecker extends EventEmitter {
  constructor() {
    super();
    this.checkInterval =
      normalizeStoredCheckInterval(process.env.MOD_CHECK_INTERVAL)
        ?.intervalMs || MOD_CHECK_INTERVAL_DEFAULT_MS;
    this.intervalId = null;
    this.initialCheckTimeout = null;
    this.lastCheck = null;
    this.steamApiHealthy = true;
    this.lastSteamApiFailureAt = null;
    this.modsNeedingUpdate = [];
    this.onUpdateCallback = null;
    this.autoRestartEnabled = false;
    this.scheduler = null;
    this.serverManager = null;
    this.io = null;
    this.workshopAcfPath = null;

    this._lastReportedUpdateKey = "";

    this.restartWarningMinutes = 5;
    this.delayIfPlayersOnline = false;
    this.maxDelayMinutes = 30;
    this.lastUpdateDetected = null;
    this.pendingRestart = false;
    this.playerCheckInterval = null;

    this.modNameCache = new Map();
    this.checkInProgress = false;
    this.lastSteamTimestamps = new Map();
    this.lastUnavailableWorkshopIds = new Map();

    this.startupGraceMs = 120000;
    this.startedAt = null;

    this.processedUpdates = new Map();
  }

  async init(scheduler, serverManager = null, io = null) {
    this.scheduler = scheduler;
    this.serverManager = serverManager;
    this.io = io;

    await this.findWorkshopAcfPath();

    try {
      let savedAutoRestart = await getSetting("modAutoRestartEnabled");
      let savedWarningMinutes = await getSetting("modRestartWarningMinutes");
      if (savedAutoRestart === null) {
        const legacyAutoRestart = parseLegacyBoolean(
          await getSetting("modAutoRestart"),
        );
        if (legacyAutoRestart !== null) {
          savedAutoRestart = legacyAutoRestart;
          await setSetting("modAutoRestartEnabled", legacyAutoRestart);
        }
      }
      if (savedWarningMinutes === null) {
        const legacyWarningMinutes = parseLegacyMinutes(
          await getSetting("modRestartDelay"),
        );
        if (legacyWarningMinutes !== null) {
          savedWarningMinutes = legacyWarningMinutes;
          await setSetting("modRestartWarningMinutes", legacyWarningMinutes);
        }
      }
      const savedDelayIfPlayers = await getSetting("modDelayIfPlayersOnline");
      const savedMaxDelay = await getSetting("modMaxDelayMinutes");
      const savedCheckInterval = await getSetting("modCheckInterval");

      if (savedWarningMinutes !== null)
        this.restartWarningMinutes = savedWarningMinutes;
      if (savedDelayIfPlayers !== null)
        this.delayIfPlayersOnline = savedDelayIfPlayers;
      if (savedMaxDelay !== null) this.maxDelayMinutes = savedMaxDelay;
      if (savedCheckInterval !== null) {
        const normalizedInterval =
          normalizeStoredCheckInterval(savedCheckInterval);
        if (normalizedInterval) {
          this.checkInterval = normalizedInterval.intervalMs;
          if (normalizedInterval.legacy) {
            await setSetting("modCheckInterval", normalizedInterval.minutes);
            log.info(
              `Migrated legacy mod check interval to ${normalizedInterval.minutes} minute(s)`,
            );
          }
        } else {
          log.warn(
            `Ignoring invalid saved mod check interval: ${savedCheckInterval}`,
          );
        }
      }

      log.info(
        `Mod checker settings restored: autoRestart=${savedAutoRestart}, warning=${this.restartWarningMinutes}min, delayIfPlayers=${this.delayIfPlayersOnline}, maxDelay=${this.maxDelayMinutes}min, checkInterval=${this.checkInterval}ms`,
      );

      if (savedAutoRestart === true) {
        this.autoRestartEnabled = true;
        if (this.scheduler) {
          this.onUpdateCallback = async (updatedMods) => {
            const handled = await this.handleModUpdate(updatedMods);
            if (!handled?.success) {
              log.warn(
                `Mod update handling failed: ${handled?.error || handled?.message || "unknown error"}`,
              );
            }
            return handled;
          };
          log.info("Auto-restart on mod update restored from settings");
        }
      }
    } catch (error) {
      log.warn(`Failed to restore mod checker settings: ${error.message}`);
    }

    await this.autoSyncModsOnStartup();
  }

  async findWorkshopAcfPath() {
    try {
      this.workshopAcfPath = null;

      const manualPath = await getSetting("modWorkshopAcfPath");
      if (manualPath && fs.existsSync(manualPath)) {
        this.workshopAcfPath = manualPath;
        log.info(`Using configured workshop ACF: ${manualPath}`);
        return manualPath;
      }

      const activeServer = await getActiveServer();
      let installPath = activeServer?.installPath;

      if (!installPath) {
        installPath = await getSetting("serverPath");
      }

      if (!installPath) {
        installPath = process.env.PZ_SERVER_PATH;
      }

      if (!installPath) {
        log.debug("Server install path not configured");
        return null;
      }

      for (const acfPath of getWorkshopAcfCandidates(installPath)) {
        if (fs.existsSync(acfPath)) {
          this.workshopAcfPath = acfPath;
          log.info(`Found workshop ACF at ${acfPath}`);
          return acfPath;
        }
      }

      log.debug(`Workshop ACF not found for install path ${installPath}`);
      return null;
    } catch (error) {
      log.warn(`Failed to find workshop ACF: ${error.message}`);
      return null;
    }
  }

  parseAcfFile(content) {
    const result = {
      installedMods: {},
      modDetails: {},
    };

    if (!content) return result;

    try {
      const lines = content.split(/\r?\n/);
      const stack = [];
      let current = {};
      const root = current;
      let pendingKey = null;

      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith("//")) continue;

        if (line === "{") {
          const key = pendingKey || "unknown";
          pendingKey = null;
          const newObj = {};
          current[key] = newObj;
          stack.push(current);
          current = newObj;
          continue;
        }

        if (line.endsWith("{")) {
          pendingKey = null;
          const keyMatch = line.match(/"([^"]+)"/);
          const key = keyMatch ? keyMatch[1] : "unknown";
          const newObj = {};
          current[key] = newObj;
          stack.push(current);
          current = newObj;
          continue;
        }

        if (line === "}") {
          pendingKey = null;
          if (stack.length > 0) {
            current = stack.pop();
          }
          continue;
        }

        const kvMatch = line.match(/"([^"]+)"\s+"([^"]*)"/);
        if (kvMatch) {
          pendingKey = null;
          current[kvMatch[1]] = kvMatch[2];
          continue;
        }

        const keyOnly = line.match(/^"([^"]+)"$/);
        if (keyOnly) {
          pendingKey = keyOnly[1];
        }
      }

      const appState = root.AppState || root.AppWorkshop || root;

      if (appState) {
        if (appState.WorkshopItemsInstalled) {
          for (const [id, data] of Object.entries(
            appState.WorkshopItemsInstalled,
          )) {
            if (typeof data === "object") {
              result.installedMods[id] = {
                size: parseInt(data.size || 0, 10),
                timeupdated: parseInt(data.timeupdated || 0, 10),
              };
            }
          }
        }

        if (appState.WorkshopItemDetails) {
          for (const [id, data] of Object.entries(
            appState.WorkshopItemDetails,
          )) {
            if (typeof data === "object") {
              result.modDetails[id] = {
                timeupdated: parseInt(data.timeupdated || 0, 10),
                latest_timeupdated: parseInt(data.latest_timeupdated || 0, 10),
              };
            }
          }
        }
      }
    } catch (error) {
      log.error(`Failed to parse ACF file: ${error.message}`);
    }

    return result;
  }

  resolveModNameFromDisk(workshopId, skipCache = false) {
    if (!skipCache && this.modNameCache.has(workshopId)) {
      return this.modNameCache.get(workshopId).name;
    }

    if (this.modNameCache.size > 500) {
      const firstKey = this.modNameCache.keys().next().value;
      this.modNameCache.delete(firstKey);
    }

    try {
      if (!this.workshopAcfPath) return null;

      const workshopDir = path.dirname(this.workshopAcfPath);
      const contentDir = path.join(
        workshopDir,
        "content",
        "108600",
        workshopId,
      );

      if (!fs.existsSync(contentDir)) return null;

      const modsDir = path.join(contentDir, "mods");
      if (fs.existsSync(modsDir)) {
        const modFolders = fs
          .readdirSync(modsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((leftName, rightName) =>
            leftName.localeCompare(rightName, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );
        for (const folder of modFolders) {
          const modFolderPath = path.join(modsDir, folder);
          const candidatePaths = [
            {
              path: path.join(modFolderPath, "mod.info"),
              version: null,
              order: 0,
            },
          ];
          try {
            const subfolders = fs
              .readdirSync(modFolderPath, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort((leftName, rightName) =>
                leftName.localeCompare(rightName, undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
              );
            for (const [subIndex, subfolder] of subfolders.entries()) {
              candidatePaths.push({
                path: path.join(modFolderPath, subfolder, "mod.info"),
                version: parseModInfoVersionFolder(subfolder),
                order: subIndex + 1,
              });
            }
          } catch {
            // Not a directory or unreadable — fall through
          }
          const modInfoPath = candidatePaths
            .filter((candidate) => fs.existsSync(candidate.path))
            .sort(compareModInfoCandidates)[0]?.path;
          if (modInfoPath) {
            let content = fs.readFileSync(modInfoPath, "utf-8");
            if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
            const nameMatch = content.match(/^\s*name\s*=\s*(.+)$/m);
            if (nameMatch && nameMatch[1]) {
              const name = nameMatch[1].trim();
              this.modNameCache.set(workshopId, {
                name,
                timestamp: Date.now(),
              });
              return name;
            }
          }
        }
        if (modFolders.length > 0) {
          const name = modFolders[0];
          this.modNameCache.set(workshopId, { name, timestamp: Date.now() });
          return name;
        }
      }

      return null;
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") {
        log.warn(
          `Permission denied resolving mod name for ${workshopId}: ${e.message}`,
        );
      } else {
        log.debug(
          `Could not resolve mod name from disk for ${workshopId}: ${e.code || e.message}`,
        );
      }
      return null;
    }
  }

  async autoSyncModsOnStartup() {
    try {
      if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
        log.debug("No workshop ACF file, skipping auto-sync");
        return;
      }

      const trackedMods = (await getTrackedMods()) || [];

      if (trackedMods.length > 0) {
        log.debug(
          `${trackedMods.length} mods already tracked, skipping auto-sync`,
        );
        return;
      }

      let content = fs.readFileSync(this.workshopAcfPath, "utf-8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const parsed = this.parseAcfFile(content);

      const workshopIds = Object.keys(parsed.installedMods);

      if (workshopIds.length === 0) {
        log.debug("No mods found in workshop ACF");
        return;
      }

      let synced = 0;
      for (const id of workshopIds) {
        if (await isModIgnored(id)) {
          log.debug(`Skipping ignored mod ${id} during auto-sync`);
          continue;
        }
        const nameFromDisk = this.resolveModNameFromDisk(id);
        const name = nameFromDisk || `Workshop Mod ${id}`;

        await addTrackedMod(id, name);
        synced++;
      }

      if (synced > 0) {
        log.info(`Auto-synced ${synced} mods from workshop ACF`);
      }
    } catch (error) {
      log.error(`Failed to auto-sync mods: ${error.message}`);
    }
  }

  get isRunning() {
    return !!this.intervalId;
  }

  start({ resetGracePeriod = true } = {}) {
    if (!this.workshopAcfPath) {
      log.warn(
        "Workshop ACF file not configured - mod update checking disabled. Configure server install path first.",
      );
      return false;
    }

    if (!fs.existsSync(this.workshopAcfPath)) {
      log.warn(`Workshop ACF file not found at ${this.workshopAcfPath}`);
      return false;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
    }

    if (resetGracePeriod || !this.startedAt) this.startedAt = Date.now();
    this.intervalId = setInterval(
      () => this.runScheduledCheck(),
      this.checkInterval,
    );
    log.info(
      `Mod checker started - checking every ${Math.round(this.checkInterval / 1000)}s (grace period: ${this.startupGraceMs / 1000}s)`,
    );

    this.initialCheckTimeout = setTimeout(() => {
      this.initialCheckTimeout = null;
      this.runScheduledCheck();
    }, 30000);
    return true;
  }

  runScheduledCheck() {
    this.checkForUpdates().catch((error) => {
      log.error(`Scheduled mod update check failed: ${error.message}`);
    });
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info("Mod checker stopped");
    }
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
  }

  async setUpdateCallback(callback) {
    this.onUpdateCallback = callback;
    this.autoRestartEnabled = !!callback;
    log.info(
      `Mod auto-restart ${this.autoRestartEnabled ? "enabled" : "disabled"}`,
    );
    await setSetting("modAutoRestartEnabled", this.autoRestartEnabled);
  }

  async setRestartOptions(options) {
    if (options.warningMinutes !== undefined) {
      const val = Number(options.warningMinutes);
      if (!isNaN(val)) {
        this.restartWarningMinutes = Math.max(0, Math.min(30, val));
        await setSetting(
          "modRestartWarningMinutes",
          this.restartWarningMinutes,
        );
      }
    }
    if (options.delayIfPlayersOnline !== undefined) {
      this.delayIfPlayersOnline = !!options.delayIfPlayersOnline;
      await setSetting("modDelayIfPlayersOnline", this.delayIfPlayersOnline);
    }
    if (options.maxDelayMinutes !== undefined) {
      const val = Number(options.maxDelayMinutes);
      if (!isNaN(val)) {
        this.maxDelayMinutes = Math.max(5, Math.min(120, val));
        await setSetting("modMaxDelayMinutes", this.maxDelayMinutes);
      }
    }
    if (options.checkInterval !== undefined)
      await this.setCheckInterval(options.checkInterval);

    log.info(
      `Mod restart options updated: warning=${this.restartWarningMinutes}min, delayIfPlayers=${this.delayIfPlayersOnline}, maxDelay=${this.maxDelayMinutes}min`,
    );
  }

  async handleModUpdate(updatedMods) {
    if (this.pendingRestart) {
      log.info("Restart already pending, ignoring handleModUpdate");
      return;
    }

    log.info(
      `handleModUpdate called with ${updatedMods.length} mod(s): ${updatedMods.map((m) => m.name).join(", ")}`,
    );

    this.pendingRestart = true;

    this.lastUpdateDetected = new Date();

    if (this.io) {
      this.io.emit("mods:update_detected", {
        mods: updatedMods,
        timestamp: this.lastUpdateDetected.toISOString(),
        autoRestart: this.autoRestartEnabled,
        warningMinutes: this.restartWarningMinutes,
      });
    }
    this.emit("update_detected", updatedMods);

    if (!this.scheduler) {
      log.warn("Scheduler not available, cannot trigger restart");
      this.pendingRestart = false;
      return { success: false, retry: true, reason: "scheduler_unavailable" };
    }

    if (this.delayIfPlayersOnline && this.serverManager) {
      try {
        const playerCount = await this.getOnlinePlayerCount();

        if (playerCount > 0) {
          log.info(
            `${playerCount} players online, delaying restart (max ${this.maxDelayMinutes} min)`,
          );
          await this.scheduler.rconService?.serverMessage(
            `🔧 Mod updates detected! Restart pending - waiting for players to leave (max ${this.maxDelayMinutes} min).`,
          );

          if (this.io) {
            this.io.emit("mods:restart_pending", {
              reason: "waiting_for_players",
              playerCount,
              maxDelayMinutes: this.maxDelayMinutes,
            });
          }

          this.startPlayerMonitoring(updatedMods);
          return {
            success: true,
            pending: true,
            markProcessed: true,
            reason: "waiting_for_players",
          };
        }
      } catch (error) {
        log.warn(`Failed to check player count: ${error.message}`);
      }
    }

    try {
      return await this.triggerModRestart(updatedMods);
    } catch (e) {
      log.error(`handleModUpdate: triggerModRestart threw: ${e.message}`);
      this.pendingRestart = false;
      return { success: false, retry: true, reason: "restart_error" };
    }
  }

  async getOnlinePlayerCount() {
    if (!this.scheduler?.rconService) return null;

    try {
      const result = await this.scheduler.rconService.getPlayers();
      if (result.success && result.players) {
        return result.players.length;
      }
    } catch (error) {
      log.debug(`Failed to get player count: ${error.message}`);
    }
    return null;
  }

  startPlayerMonitoring(updatedMods) {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
    }

    this.pendingRestart = true;
    const startTime = Date.now();
    const maxWaitMs = this.maxDelayMinutes * 60 * 1000;

    this.playerCheckInterval = setInterval(async () => {
      try {
        const elapsed = Date.now() - startTime;

        if (elapsed >= maxWaitMs) {
          log.info("Max delay exceeded, forcing restart");
          clearInterval(this.playerCheckInterval);
          this.playerCheckInterval = null;
          try {
            const result = await this.triggerModRestart(updatedMods);
            if (!result?.success) {
              log.error(
                `Player monitor: mod restart did not run: ${result?.error || result?.message || "unknown error"}`,
              );
              this.pendingRestart = false;
            }
          } catch (e) {
            log.error(`Player monitor: triggerModRestart threw: ${e.message}`);
            this.pendingRestart = false;
          }
          return;
        }

        const playerCount = await this.getOnlinePlayerCount();

        if (playerCount === null) {
          const remainingMin = Math.round((maxWaitMs - elapsed) / 60000);
          log.warn(
            `Player count unavailable (RCON); keeping restart on hold, ${remainingMin} min remaining`,
          );
        } else if (playerCount === 0) {
          log.info("No players online, triggering restart");
          clearInterval(this.playerCheckInterval);
          this.playerCheckInterval = null;
          try {
            const result = await this.triggerModRestart(updatedMods);
            if (!result?.success) {
              log.error(
                `Player monitor: mod restart did not run: ${result?.error || result?.message || "unknown error"}`,
              );
              this.pendingRestart = false;
            }
          } catch (e) {
            log.error(`Player monitor: triggerModRestart threw: ${e.message}`);
            this.pendingRestart = false;
          }
        } else {
          const remainingMin = Math.round((maxWaitMs - elapsed) / 60000);
          log.debug(
            `${playerCount} players still online, ${remainingMin} min remaining`,
          );
        }
      } catch (error) {
        log.error(`Player monitoring error: ${error.message}`);
        clearInterval(this.playerCheckInterval);
        this.playerCheckInterval = null;
        this.pendingRestart = false;
      }
    }, 120000);
  }

  async triggerModRestart(updatedMods) {
    log.info(`Triggering restart for ${updatedMods.length} updated mod(s)`);

    const rconService = this.scheduler?.rconService;
    if (!rconService || !rconService.connected) {
      let confirmedOffline = false;
      if (
        this.serverManager &&
        typeof this.serverManager.getServerProcessDetails === "function"
      ) {
        try {
          const details = await this.serverManager.getServerProcessDetails();
          confirmedOffline = !details.running && !details.scanFailed;
        } catch (error) {
          log.debug(
            `Could not verify server process before mod restart retry decision: ${error.message}`,
          );
        }
      }

      if (confirmedOffline) {
        log.info(
          "Mod updates detected while the PZ server is offline — no restart needed until the server is running.",
        );
        this.pendingRestart = false;
        return {
          success: true,
          skipped: true,
          markProcessed: true,
          reason: "server_offline",
        };
      }

      log.warn(
        "RCON not connected while server appears to be running — cannot trigger mod restart safely. Will retry on next check cycle.",
      );
      for (const m of updatedMods) {
        this.processedUpdates.delete(m.workshopId);
      }
      this.pendingRestart = false;
      return { success: false, retry: true, reason: "rcon_disconnected" };
    }

    const modNames = updatedMods
      .map((m) => String(m.name || "Unknown").replace(/[\r\n]/g, ""))
      .join(", ");

    if (this.io) {
      this.io.emit("mods:restart_starting", {
        mods: updatedMods,
        warningMinutes: this.restartWarningMinutes,
      });
    }

    try {
      const trimmedNames =
        modNames.length > 100 ? `${modNames.substring(0, 100)}...` : modNames;
      const warningMessage = `🔧 Mod updates detected: ${trimmedNames}. Server will restart in ${this.restartWarningMinutes} minute(s).`;
      log.info(
        `Sending mod-restart warning: ${trimmedNames} — restart in ${this.restartWarningMinutes} min`,
      );

      let rconBroadcastOk = false;
      try {
        const rconResult =
          await this.scheduler.rconService?.serverMessage(warningMessage);
        if (rconResult?.success && !rconResult.rejected) {
          rconBroadcastOk = true;
        } else if (rconResult?.rejected) {
          log.warn(
            "RCON servermsg was rejected by PZ — will rely on PanelBridge fallback",
          );
        }
      } catch (rconErr) {
        log.warn(`RCON serverMessage failed: ${rconErr?.message || rconErr}`);
      }

      try {
        if (panelBridge?.isRunning && panelBridge?.isModConnected?.()) {
          await panelBridge.sendCommand("sendToServerChat", {
            message: warningMessage,
            alert: true,
          });
        } else if (!rconBroadcastOk) {
          log.warn(
            "Mod restart warning: neither RCON broadcast nor PanelBridge succeeded — players may not see the warning",
          );
        }
      } catch (bridgeErr) {
        log.warn(
          `PanelBridge sendToServerChat failed: ${bridgeErr?.message || bridgeErr}`,
        );
      }

      log.info(
        `Calling scheduler.performRestart(${this.restartWarningMinutes})`,
      );
      const result = await this.scheduler.performRestart(
        this.restartWarningMinutes,
      );

      if (result && result.success === false) {
        log.warn(
          `Mod restart did not complete: ${result.message || "unknown reason"}`,
        );
        if (this.io) {
          this.io.emit("mods:restart_failed", {
            error: result.message || "Restart did not complete",
          });
        }
        for (const m of updatedMods) {
          this.processedUpdates.delete(m.workshopId);
        }
        return { success: false, retry: true, reason: "restart_incomplete" };
      }

      log.info(
        `Mod restart completed successfully for: ${modNames.substring(0, 200)}`,
      );
      await logServerEvent(
        "mod_update_restart",
        `Restarted for mod updates: ${modNames}`,
      );

      if (this.io) {
        this.io.emit("mods:restart_complete", { mods: updatedMods });
      }
      return { success: true, markProcessed: true, reason: "restart_complete" };
    } catch (error) {
      log.error(`Restart failed: ${error.message}`);
      if (this.io) {
        this.io.emit("mods:restart_failed", {
          error: sanitizeError(error.message),
        });
      }
      for (const m of updatedMods) {
        this.processedUpdates.delete(m.workshopId);
      }
      return { success: false, retry: true, reason: "restart_error" };
    } finally {
      this.pendingRestart = false;
    }
  }

  async getConfiguredWorkshopIds() {
    if (
      !this.serverManager ||
      typeof this.serverManager.getServerConfig !== "function"
    ) {
      return null;
    }
    try {
      const config = await this.serverManager.getServerConfig();
      if (!config || !config.WorkshopItems) return null;
      const ids = String(config.WorkshopItems)
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      return new Set(ids);
    } catch (err) {
      log.debug(`getConfiguredWorkshopIds failed: ${err.message}`);
      return null;
    }
  }

  async fetchSteamTimestamps(workshopIds) {
    const result = new Map();
    const unavailable = new Map();
    if (!workshopIds.length) {
      this.lastUnavailableWorkshopIds = unavailable;
      return result;
    }

    const BATCH = 100;
    let backoffMs = 0;
    const MAX_BACKOFF_MS = 60_000;
    for (let i = 0; i < workshopIds.length; i += BATCH) {
      const batch = workshopIds.slice(i, i + BATCH);
      let timeout;
      if (backoffMs > 0) {
        log.warn(
          `Steam API backoff: sleeping ${backoffMs}ms before next batch`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      try {
        const params = new URLSearchParams();
        params.set("itemcount", String(batch.length));
        batch.forEach((id, idx) => params.set(`publishedfileids[${idx}]`, id));

        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(
          "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
          { method: "POST", body: params, signal: controller.signal },
        );
        clearTimeout(timeout);
        timeout = null;

        if (!res.ok) {
          log.warn(
            `Steam API returned ${res.status} for batch ${i / BATCH + 1}`,
          );
          if (res.status === 429 || res.status === 503) {
            const retryAfter = parseInt(
              res.headers.get("retry-after") || "",
              10,
            );
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              backoffMs = Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
            } else {
              backoffMs = Math.min(
                Math.max(backoffMs * 2, 2000),
                MAX_BACKOFF_MS,
              );
            }
          }
          continue;
        }

        backoffMs = 0;

        const data = await res.json();
        const items = data?.response?.publishedfiledetails || [];
        for (const item of items) {
          if (!item.publishedfileid) continue;
          if (item.result === 1) {
            result.set(item.publishedfileid, {
              time_updated: item.time_updated || 0,
              title: item.title || null,
              file_type: item.file_type ?? 0,
              creator_app_id: item.creator_app_id || 0,
              preview_url:
                typeof item.preview_url === "string" ? item.preview_url : null,
            });
          } else {
            unavailable.set(item.publishedfileid, {
              resultCode: item.result,
              reason: item.result === 9 ? "removed" : "unknown",
            });
          }
        }
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        if (err.name === "AbortError") {
          log.warn(`Steam API timeout for batch ${i / BATCH + 1}`);
        } else {
          log.warn(
            `Steam API error for batch ${i / BATCH + 1}: ${err.message}`,
          );
        }
      }
    }

    if (result.size > 0 && result.size < workshopIds.length) {
      log.debug(
        `Steam API returned data for ${result.size}/${workshopIds.length} mods (partial)`,
      );
    }

    this.lastUnavailableWorkshopIds = unavailable;
    const removedIds = [...unavailable.entries()]
      .filter(([, info]) => info.reason === "removed")
      .map(([id]) => id);
    if (removedIds.length > 0) {
      log.warn(
        `Steam confirms ${removedIds.length} workshop item(s) no longer exist (removed or made private): ${removedIds.join(", ")}`,
      );
    }

    return result;
  }

  async checkForUpdates() {
    if (this.checkInProgress) {
      log.debug("Update check already in progress, skipping");
      return { updated: false, mods: [], skipped: true };
    }
    this.checkInProgress = true;

    try {
      if (!this.workshopAcfPath) {
        await this.findWorkshopAcfPath();
      }

      if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
        log.warn("Workshop ACF file not found - cannot check for updates");
        return {
          updated: false,
          mods: [],
          error: "Workshop ACF file not found",
        };
      }

      let content = fs.readFileSync(this.workshopAcfPath, "utf-8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const parsed = this.parseAcfFile(content);

      const localTimestamps = new Map();
      for (const [id, data] of Object.entries(parsed.installedMods)) {
        localTimestamps.set(id, data.timeupdated);
      }
      for (const [id, data] of Object.entries(parsed.modDetails)) {
        if (!localTimestamps.has(id)) {
          localTimestamps.set(id, data.timeupdated);
        }
      }

      const modCount = localTimestamps.size;
      if (modCount === 0) {
        log.debug("No workshop mods found in ACF file");
        return { updated: false, mods: [] };
      }

      log.debug(
        `Checking ${modCount} workshop mods for updates via Steam API...`,
      );

      const updatedMods = [];
      const trackedMods = (await getTrackedMods()) || [];
      const trackedMap = new Map();
      for (const mod of trackedMods) {
        trackedMap.set(mod.workshop_id, mod);
      }

      const queryIds = new Set(localTimestamps.keys());
      for (const mod of trackedMods) {
        if (mod.workshop_id && /^\d{1,15}$/.test(mod.workshop_id)) {
          queryIds.add(mod.workshop_id);
        }
      }
      const workshopIds = [...queryIds];
      const steamData = await this.fetchSteamTimestamps(workshopIds);

      if (steamData.size > 0) {
        this.lastSteamTimestamps = steamData;

        try {
          const { setModPreviewUrl } = await import("../database/init.js");
          for (const mod of trackedMods) {
            const steam = steamData.get(mod.workshop_id);
            if (
              steam &&
              steam.preview_url &&
              mod.preview_url !== steam.preview_url
            ) {
              await setModPreviewUrl(mod.workshop_id, steam.preview_url);
            }
          }
        } catch (err) {
          log.debug(`Failed to persist mod preview URLs: ${err.message}`);
        }
      }

      this.steamApiHealthy =
        steamData.size > 0 ||
        this.lastUnavailableWorkshopIds.size > 0 ||
        workshopIds.length === 0;
      this.lastSteamApiFailureAt = this.steamApiHealthy
        ? this.lastSteamApiFailureAt
        : new Date();

      if (steamData.size === 0) {
        log.warn("Steam API returned no data, falling back to ACF-only check");
        for (const [workshopId, details] of Object.entries(parsed.modDetails)) {
          const { timeupdated, latest_timeupdated } = details;
          if (latest_timeupdated > timeupdated) {
            if (
              !trackedMap.has(workshopId) &&
              (await isModIgnored(workshopId))
            ) {
              log.debug(
                `Skipping ignored mod ${workshopId} during ACF-only update check`,
              );
              continue;
            }
            const trackedMod = trackedMap.get(workshopId);
            const nameFromDisk = this.resolveModNameFromDisk(workshopId);
            const modName =
              nameFromDisk || trackedMod?.name || `Workshop Mod ${workshopId}`;
            log.info(`Mod update available (ACF): ${modName} (${workshopId})`);
            updatedMods.push({
              workshopId,
              name: modName,
              localTimestamp: new Date(timeupdated * 1000),
              latestTimestamp: new Date(latest_timeupdated * 1000),
            });
          }
        }
      } else {
        for (const [workshopId, localTime] of localTimestamps) {
          const steam = steamData.get(workshopId);
          if (!steam) continue;

          if (steam.time_updated > localTime) {
            const trackedMod = trackedMap.get(workshopId);

            if (!trackedMod && (await isModIgnored(workshopId))) {
              log.debug(
                `Skipping ignored mod ${workshopId} during update check`,
              );
              continue;
            }

            const nameFromDisk = this.resolveModNameFromDisk(workshopId);
            const modName =
              nameFromDisk ||
              steam.title ||
              trackedMod?.name ||
              `Workshop Mod ${workshopId}`;

            if (
              trackedMod &&
              nameFromDisk &&
              trackedMod.name !== nameFromDisk
            ) {
              trackedMod.name = nameFromDisk;
              await addTrackedMod(workshopId, nameFromDisk);
            }

            log.info(
              `Mod update available: ${modName} (${workshopId}) - local: ${localTime}, steam: ${steam.time_updated}`,
            );

            updatedMods.push({
              workshopId,
              name: modName,
              localTimestamp: new Date(localTime * 1000),
              latestTimestamp: new Date(steam.time_updated * 1000),
            });

            if (!trackedMod) {
              await addTrackedMod(workshopId, modName);
              trackedMap.set(workshopId, {
                workshop_id: workshopId,
                name: modName,
              });
            }

            if (this.modNameCache.has(workshopId)) {
              this.modNameCache.delete(workshopId);
            }
          }
        }
      }

      this.lastCheck = new Date();

      try {
        const iniWorkshopIds = await this.getConfiguredWorkshopIds();
        if (iniWorkshopIds && iniWorkshopIds.size > 0) {
          const before = updatedMods.length;
          const filtered = updatedMods.filter((m) =>
            iniWorkshopIds.has(String(m.workshopId)),
          );
          const skipped = before - filtered.length;
          if (skipped > 0) {
            const skippedNames = updatedMods
              .filter((m) => !iniWorkshopIds.has(String(m.workshopId)))
              .map((m) => `${m.name} (${m.workshopId})`)
              .join(", ");
            log.info(
              `Skipping ${skipped} phantom update(s) for mods not in server INI: ${skippedNames}`,
            );
          }
          updatedMods.length = 0;
          updatedMods.push(...filtered);
        } else {
          log.debug(
            "Could not read server INI workshop IDs — not filtering phantom updates",
          );
        }
      } catch (filterErr) {
        log.warn(
          `Failed to filter updates against INI config: ${filterErr.message}`,
        );
      }

      this.modsNeedingUpdate = updatedMods;

      try {
        const updatesById = new Map(updatedMods.map((m) => [m.workshopId, 1]));
        let checkedIds;
        if (steamData.size > 0) {
          checkedIds = new Set(steamData.keys());
        } else {
          checkedIds = new Set([
            ...localTimestamps.keys(),
            ...trackedMap.keys(),
          ]);
        }
        await markModsChecked(checkedIds, updatesById);
      } catch (markErr) {
        log.warn(`Failed to mark mods as checked: ${markErr.message}`);
      }

      if (updatedMods.length > 0) {
        const updateKey = updatedMods
          .map((m) => `${m.workshopId}@${m.latestTimestamp?.getTime?.() || 0}`)
          .sort()
          .join(",");
        const isNewReport = updateKey !== this._lastReportedUpdateKey;
        this._lastReportedUpdateKey = updateKey;

        if (isNewReport) {
          log.info(`${updatedMods.length} mod(s) have updates available`);
          await logServerEvent(
            "mod_update_detected",
            JSON.stringify(updatedMods.map((m) => m.name)),
          );

          if (this.io) {
            this.io.emit("mods:updates_available", {
              count: updatedMods.length,
              mods: updatedMods,
            });
          }
        } else {
          log.debug(
            `${updatedMods.length} mod(s) still need updates (unchanged set, skipping re-notify)`,
          );
        }

        const newUpdates = updatedMods.filter((m) => {
          const steamTs = m.latestTimestamp?.getTime?.() || 0;
          const prevTs = this.processedUpdates.get(m.workshopId);
          if (prevTs && prevTs === steamTs) {
            log.debug(
              `Skipping already-processed update for ${m.name} (${m.workshopId}) — steam ts: ${steamTs}`,
            );
            return false;
          }
          return true;
        });

        if (newUpdates.length === 0 && updatedMods.length > 0) {
          log.info(
            `All ${updatedMods.length} update(s) already processed — skipping callback`,
          );
        }

        const inGracePeriod =
          this.startedAt && Date.now() - this.startedAt < this.startupGraceMs;
        if (inGracePeriod && newUpdates.length > 0) {
          const remaining = Math.round(
            (this.startupGraceMs - (Date.now() - this.startedAt)) / 1000,
          );
          log.info(
            `Startup grace period active (${remaining}s remaining) — skipping auto-restart for ${newUpdates.length} update(s)`,
          );
          newUpdates.length = 0;
        }

        if (
          this.onUpdateCallback &&
          !this.pendingRestart &&
          newUpdates.length > 0
        ) {
          try {
            log.info(
              `Triggering auto-restart callback for ${newUpdates.length} new update(s)`,
            );
            const callbackResult = await this.onUpdateCallback(newUpdates);
            if (this.pendingRestart || callbackResult?.markProcessed === true) {
              for (const m of newUpdates) {
                const steamTs = m.latestTimestamp?.getTime?.() || 0;
                if (steamTs) {
                  this.processedUpdates.set(m.workshopId, steamTs);
                }
              }
              if (callbackResult?.reason) {
                log.debug(
                  `Marked mod updates processed after ${callbackResult.reason}`,
                );
              }
            } else {
              log.info(
                "Restart did not proceed (likely aborted) — keeping updates eligible for retry on next cycle",
              );
            }
          } catch (callbackError) {
            log.error(`Mod update callback failed: ${callbackError.message}`);
          }
        } else if (this.pendingRestart) {
          log.debug("Restart already pending, skipping callback");
        }
      } else {
        if (this._lastReportedUpdateKey !== "") {
          this._lastReportedUpdateKey = "";
          if (this.io) {
            this.io.emit("mods:updates_available", { count: 0, mods: [] });
          }
        }
        log.debug("No mod updates available");
      }

      return {
        updated: updatedMods.length > 0,
        mods: updatedMods,
        source: this.steamApiHealthy ? "steam" : "acf-only",
      };
    } catch (error) {
      log.error(`Mod update check failed: ${error.message}`);
      return { updated: false, mods: [], error: error.message, source: "error" };
    } finally {
      this.checkInProgress = false;
    }
  }

  async getWorkshopInfo() {
    if (!this.workshopAcfPath || !fs.existsSync(this.workshopAcfPath)) {
      return {};
    }

    try {
      let content = fs.readFileSync(this.workshopAcfPath, "utf-8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const parsed = this.parseAcfFile(content);

      const result = {};
      for (const [workshopId, installed] of Object.entries(
        parsed.installedMods,
      )) {
        const details = parsed.modDetails[workshopId] || {};
        const steamInfo = this.lastSteamTimestamps.get(workshopId);
        const latestTime =
          steamInfo?.time_updated ||
          details.latest_timeupdated ||
          installed.timeupdated;
        result[workshopId] = {
          size: installed.size,
          timeupdated: installed.timeupdated,
          latest_timeupdated: latestTime,
          needsUpdate: latestTime > installed.timeupdated,
        };
      }

      return result;
    } catch (error) {
      log.error(`Failed to read workshop ACF: ${error.message}`);
      return {};
    }
  }

  async addModToTrack(workshopId) {
    try {
      const { addTrackedMod } = await import("../database/init.js");

      const nameFromDisk = this.resolveModNameFromDisk(workshopId);
      const modName = nameFromDisk || `Workshop Mod ${workshopId}`;

      const allInfo = await this.getWorkshopInfo();
      const modInfo = allInfo[workshopId];

      if (modInfo) {
        await addTrackedMod(workshopId, modName);
        if (modInfo.timeupdated) {
          await updateModTimestamp(
            workshopId,
            new Date(modInfo.timeupdated * 1000).toISOString(),
          );
        }
        return {
          success: true,
          name: modName,
          needsUpdate: modInfo.needsUpdate,
        };
      } else {
        await addTrackedMod(workshopId, modName);
        return {
          success: true,
          name: modName,
          note: "Mod not found in Steam Workshop cache - may not be subscribed",
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getStatus() {
    const trackedMods = (await getTrackedMods()) || [];
    const trackedWorkshopIds = new Set(
      trackedMods
        .map((mod) => String(mod?.workshop_id ?? "").trim())
        .filter(Boolean),
    );
    const workshopInfo = await this.getWorkshopInfo();
    let iniWorkshopIds = null;
    try {
      iniWorkshopIds = await this.getConfiguredWorkshopIds();
    } catch {
      /* fall through — leave null to skip filter */
    }
    const modsWithUpdates = Object.entries(workshopInfo).filter(
      ([id, info]) => {
        if (!info.needsUpdate) return false;
        if (
          iniWorkshopIds &&
          iniWorkshopIds.size > 0 &&
          !iniWorkshopIds.has(String(id))
        )
          return false;
        return true;
      },
    ).length;

    return {
      running: !!this.intervalId,
      lastCheck:
        this.lastCheck instanceof Date
          ? this.lastCheck.toISOString()
          : this.lastCheck || null,
      lastUpdateDetected:
        this.lastUpdateDetected instanceof Date
          ? this.lastUpdateDetected.toISOString()
          : this.lastUpdateDetected || null,
      checkInterval: this.checkInterval,
      modsNeedingUpdate: this.modsNeedingUpdate,
      workshopAcfConfigured:
        !!this.workshopAcfPath && fs.existsSync(this.workshopAcfPath),
      workshopAcfPath: this.workshopAcfPath,
      totalModsInWorkshop: Object.keys(workshopInfo).length,
      totalModsTracked: Array.isArray(trackedMods) ? trackedMods.length : 0,
      updatesAvailable: modsWithUpdates,
      steamApiHealthy: this.steamApiHealthy,
      lastSteamApiFailureAt: this.lastSteamApiFailureAt
        ? this.lastSteamApiFailureAt.toISOString()
        : null,
      removedWorkshopIds: [...this.lastUnavailableWorkshopIds.entries()]
        .filter(
          ([id, info]) =>
            info.reason === "removed" && trackedWorkshopIds.has(String(id)),
        )
        .map(([id]) => id),
      unknownWorkshopIds: [...this.lastUnavailableWorkshopIds.entries()]
        .filter(
          ([id, info]) =>
            info.reason === "unknown" && trackedWorkshopIds.has(String(id)),
        )
        .map(([id, info]) => ({ id, resultCode: info.resultCode })),
      autoRestartEnabled: this.autoRestartEnabled,
      restartWarningMinutes: this.restartWarningMinutes,
      delayIfPlayersOnline: this.delayIfPlayersOnline,
      maxDelayMinutes: this.maxDelayMinutes,
      pendingRestart: this.pendingRestart,
    };
  }

  async setCheckInterval(intervalMs) {
    const normalizedInterval = normalizeStoredCheckInterval(intervalMs);
    if (!normalizedInterval || normalizedInterval.legacy === false) {
      throw new RangeError(
        `Check interval must be ${MOD_CHECK_INTERVAL_MINUTES_MIN}-${MOD_CHECK_INTERVAL_MINUTES_MAX} whole minutes in milliseconds`,
      );
    }

    this.checkInterval = normalizedInterval.intervalMs;
    await setSetting("modCheckInterval", normalizedInterval.minutes);
    if (this.intervalId) {
      this.start({ resetGracePeriod: false });
    }
    return this.checkInterval;
  }

  async setCheckIntervalMinutes(minutes) {
    const intervalMs = minutesToCheckIntervalMs(minutes);
    if (intervalMs === null) {
      throw new RangeError(
        `Check interval must be ${MOD_CHECK_INTERVAL_MINUTES_MIN}-${MOD_CHECK_INTERVAL_MINUTES_MAX} whole minutes`,
      );
    }
    return this.setCheckInterval(intervalMs);
  }

  cancelPendingRestart() {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
    this.pendingRestart = false;
    this.processedUpdates.clear();
    this.scheduler?.cancelRestart();
    log.info("Pending restart cancelled");

    if (this.io) {
      this.io.emit("mods:restart_cancelled", {});
    }
  }
}

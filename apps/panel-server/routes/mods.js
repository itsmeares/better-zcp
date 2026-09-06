import express from "express";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import os from "os";
import crypto from "crypto";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Mods");
import {
  getTrackedMods,
  addTrackedMod,
  removeTrackedMod,
  clearModUpdates,
  getSetting,
  getActiveServer,
  getModPresets,
  createModPreset,
  updateModPreset,
  deleteModPreset,
  addIgnoredMod,
  getIgnoredMods,
  removeIgnoredMod,
  clearAllIgnoredMods,
  isModIgnored,
  getIgnoredModPairs,
  addIgnoredModPair,
  removeIgnoredModPair,
} from "../database/init.js";
import { getDataPaths } from "../utils/paths.js";
import { getSteamApiKey } from "../services/steamApiKey.ts";
import {
  sanitizeError,
  sanitizeErrorParams,
  sanitizeIniValue,
  sanitizeIniList,
  sanitizeModIdList,
  looksLikeWorkshopId,
} from "../utils/sanitize.ts";
import {
  getCollectionContents,
  addItemToCollection,
  removeItemFromCollection,
  computeDiff as computeCollectionDiff,
  syncSingleChange as autoSyncCollection,
  fetchPublishedFileTitles,
  getSteamSessionCredentials,
  setSteamSessionCredentials,
} from "../services/workshopCollectionSync.js";
import {
  listAvailableBrowsers,
  extractSteamCookies,
} from "../utils/browserCookies.js";
import { requirePermission } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.ts";
import { withFileLock } from "../utils/fileWriteQueue.ts";
import { writeIniWithBackup, backupWarningFor } from "../utils/configBackup.ts";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";

const router = express.Router();

const requireModsManage = requirePermission("mods.manage");
router.use((req, res, next) => {
  if (req.path.startsWith("/thumbnail/")) return next();
  return requireModsManage(req, res, next);
});

const activeIniLocks = new Map();
export function withIniLock(iniPath, fn) {
  activeIniLocks.set(iniPath, (activeIniLocks.get(iniPath) || 0) + 1);
  const cleanup = () => {
    const remaining = (activeIniLocks.get(iniPath) || 1) - 1;
    if (remaining <= 0) activeIniLocks.delete(iniPath);
    else activeIniLocks.set(iniPath, remaining);
  };
  const run = withFileLock(iniPath, fn);
  run.then(cleanup, cleanup);
  return run;
}

export function getIniLockCount() {
  return activeIniLocks.size;
}

export function filterOwnedClientModIds(clientModIds, ownedModIds) {
  const ownedSet = new Set((ownedModIds || []).map(String));
  if (!ownedSet.size || !Array.isArray(clientModIds)) return [];

  const filtered = [];
  const seen = new Set();
  for (const rawId of clientModIds) {
    if (typeof rawId !== "string") continue;
    const modId = sanitizeIniValue(rawId).trim();
    if (!modId || modId.length >= 200) continue;
    if (looksLikeWorkshopId(modId)) continue;
    if (!ownedSet.has(modId) || seen.has(modId)) continue;
    seen.add(modId);
    filtered.push(modId);
  }
  return filtered;
}

function stripBom(str) {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

function readTextFile(filePath) {
  return stripBom(fs.readFileSync(filePath, "utf-8")).replace(/\r\n/g, "\n");
}


function getSanitizedIniPath(serverConfigPath, serverName) {
  if (!serverConfigPath || typeof serverName !== "string") {
    return null;
  }

  const sanitizedServerName = path.basename(serverName);
  if (
    !sanitizedServerName ||
    sanitizedServerName !== serverName ||
    serverName.includes("..")
  ) {
    return null;
  }

  return path.join(serverConfigPath, `${sanitizedServerName}.ini`);
}

async function getServerConfigPath() {
  const activeServer = await getActiveServer();

  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }

  if (activeServer?.zomboidDataPath) {
    return path.join(activeServer.zomboidDataPath, "Server");
  }

  const legacyPath = await getSetting("serverConfigPath");
  if (legacyPath) return legacyPath;

  const legacyZomboidPath = await getSetting("zomboidDataPath");
  if (legacyZomboidPath) {
    return path.join(legacyZomboidPath, "Server");
  }

  return null;
}

async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }
  const legacyName = await getSetting("serverName");
  return legacyName || null;
}

async function getServerPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.installPath) {
    return activeServer.installPath;
  }
  const legacyPath = await getSetting("serverPath");
  return legacyPath || null;
}

function getModChecker(req, res) {
  const modChecker = req.app.get("modChecker");
  if (!modChecker) {
    res.status(500).json({
      error: "Mod checker not initialized",
      code: ErrorCode.MOD_CHECKER_NOT_INITIALIZED,
    });
    return null;
  }
  return modChecker;
}

function shouldRefreshTrackedModName(name) {
  return (
    !name || /^Workshop Mod /i.test(name) || /\[\s*Legacy\s*\]/i.test(name)
  );
}

router.get("/status", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const status = await modChecker.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get mod checker status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/tracked", async (req, res) => {
  try {
    try {
      const serverConfigPath = await getServerConfigPath();
      const serverName = await getServerName();
      if (serverConfigPath && serverName) {
        const sanitizedServerName = path.basename(serverName);
        if (sanitizedServerName === serverName && !serverName.includes("..")) {
          const iniPath = path.join(
            serverConfigPath,
            `${sanitizedServerName}.ini`,
          );
          if (fs.existsSync(iniPath)) {
            const content = readTextFile(iniPath);
            const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
            const workshopIds =
              workshopMatch?.[1]?.split(";").filter(Boolean) || [];
            const configuredIds = new Set(
              workshopIds.filter((id) => /^\d{1,15}$/.test(id)),
            );
            const trackedNow = await getTrackedMods();

            if (configuredIds.size > 0) {
              const trackedSet = new Set(
                trackedNow.map((m) => m.workshop_id),
              );
              const modChecker = req.app.get("modChecker");
              let added = 0;
              for (const wsId of configuredIds) {
                if (trackedSet.has(wsId)) continue;
                if (await isModIgnored(wsId)) continue;
                const nameFromDisk = modChecker?.resolveModNameFromDisk(wsId);
                await addTrackedMod(
                  wsId,
                  nameFromDisk || `Workshop Mod ${wsId}`,
                );
                added++;
              }
              if (added > 0) log.info(`Auto-tracked ${added} mods from INI`);
            }
          }
        }
      }
    } catch (e) {
      log.debug(`Auto-track from INI skipped: ${e.message}`);
    }

    const mods = await getTrackedMods();

    const modChecker = req.app.get("modChecker");
    if (modChecker) {
      let updated = 0;
      const unresolvedIds = [];
      for (const mod of mods) {
        if (shouldRefreshTrackedModName(mod.name)) {
          const realName = modChecker.resolveModNameFromDisk(
            mod.workshop_id,
            true,
          );
          if (realName && realName !== mod.name) {
            mod.name = realName;
            await addTrackedMod(mod.workshop_id, realName);
            updated++;
          } else {
            unresolvedIds.push(mod.workshop_id);
          }
        }
      }
      if (unresolvedIds.length > 0) {
        const titles = await fetchPublishedFileTitles(unresolvedIds);
        for (const mod of mods) {
          const realName = titles.get(mod.workshop_id);
          if (realName && shouldRefreshTrackedModName(mod.name)) {
            mod.name = realName;
            await addTrackedMod(mod.workshop_id, realName);
            updated++;
          }
        }
      }
      if (updated > 0) {
        log.debug(`Resolved ${updated} tracked mod names`);
      }
    }

    res.json({ mods });
  } catch (error) {
    log.error(`Failed to get tracked mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/refresh-names", async (req, res) => {
  try {
    const modChecker = req.app.get("modChecker");
    const { workshopIds } = req.body || {};
    const targetSet =
      Array.isArray(workshopIds) && workshopIds.length > 0
        ? new Set(workshopIds.map(String).filter((id) => /^\d{1,15}$/.test(id)))
        : null;

    const mods = await getTrackedMods();
    const candidates = mods.filter((m) => {
      if (targetSet && !targetSet.has(m.workshop_id)) return false;
      return shouldRefreshTrackedModName(m.name);
    });

    let diskResolved = 0;
    let steamResolved = 0;
    const stillUnresolved = [];

    for (const mod of candidates) {
      const nameFromDisk = modChecker?.resolveModNameFromDisk(
        mod.workshop_id,
        true,
      );
      if (nameFromDisk) {
        await addTrackedMod(mod.workshop_id, nameFromDisk);
        diskResolved++;
      } else {
        stillUnresolved.push(mod.workshop_id);
      }
    }

    if (stillUnresolved.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < stillUnresolved.length; i += BATCH) {
        const slice = stillUnresolved.slice(i, i + BATCH);
        const params = new URLSearchParams();
        params.append("itemcount", String(slice.length));
        slice.forEach((id, idx) =>
          params.append(`publishedfileids[${idx}]`, id),
        );
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          const r = await fetch(
            "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
            { method: "POST", body: params, signal: controller.signal },
          );
          clearTimeout(timer);
          if (!r.ok) continue;
          const data = await r.json();
          const items = data?.response?.publishedfiledetails || [];
          for (const item of items) {
            if (
              item?.result === 1 &&
              typeof item.title === "string" &&
              item.title.trim()
            ) {
              await addTrackedMod(
                String(item.publishedfileid),
                item.title.trim(),
              );
              steamResolved++;
            }
          }
        } catch (e) {
          log.debug(`Steam name refresh batch failed: ${e.message}`);
        }
      }
    }

    res.json({
      success: true,
      checked: candidates.length,
      diskResolved,
      steamResolved,
      totalResolved: diskResolved + steamResolved,
      unresolved: candidates.length - diskResolved - steamResolved,
    });
  } catch (error) {
    log.error(`Failed to refresh mod names: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/track", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const { workshopId } = req.body;
    log.info(`POST /track: workshopId=${workshopId}`);

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    const workshopIdStr = String(workshopId);
    if (!/^\d{1,15}$/.test(workshopIdStr)) {
      return res.status(400).json({
        error: "Invalid Workshop ID format",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_FORMAT,
      });
    }

    await removeIgnoredMod(workshopIdStr);

    const result = await modChecker.addModToTrack(workshopIdStr);
    autoSyncCollection("add", workshopIdStr).catch(() => {});
    res.json(result);
  } catch (error) {
    log.error(`Failed to add mod to track: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/track/:workshopId", async (req, res) => {
  try {
    const { workshopId } = req.params;

    if (!workshopId || !/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    const trackedMods = await getTrackedMods();
    const mod = trackedMods.find((m) => m.workshop_id === workshopId);

    await removeTrackedMod(workshopId);
    await addIgnoredMod(workshopId, mod?.name || null);
    autoSyncCollection("remove", workshopId).catch(() => {});
    res.json({
      success: true,
      message: "Mod removed from tracking and added to ignore list",
    });
  } catch (error) {
    log.error(`Failed to remove tracked mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/ignored", async (req, res) => {
  try {
    const ignored = await getIgnoredMods();
    res.json(ignored);
  } catch (error) {
    log.error(`Failed to get ignored mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/ignored/:workshopId", async (req, res) => {
  try {
    const { workshopId } = req.params;
    if (!workshopId || !/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const removed = await removeIgnoredMod(workshopId);
    if (!removed) {
      return res.status(404).json({
        error: "Mod not found in ignore list",
        code: ErrorCode.MODS_IGNORE_ENTRY_NOT_FOUND,
      });
    }
    res.json({ success: true, message: "Mod removed from ignore list" });
  } catch (error) {
    log.error(`Failed to un-ignore mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/ignored", async (req, res) => {
  try {
    const removed = await clearAllIgnoredMods();
    res.json({
      success: true,
      message: `Cleared ${removed} ignored mod${removed !== 1 ? "s" : ""}`,
      removed,
    });
  } catch (error) {
    log.error(`Failed to clear ignored mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


const MOD_ID_RE = /^[A-Za-z0-9_.\-+ ()]{1,128}$/;

router.get("/ignored-pairs", async (req, res) => {
  try {
    const pairs = await getIgnoredModPairs();
    res.json(pairs);
  } catch (error) {
    log.error(`Failed to get ignored mod pairs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/ignored-pairs", async (req, res) => {
  try {
    const { modIdA, modIdB, reason } = req.body || {};
    if (
      typeof modIdA !== "string" ||
      typeof modIdB !== "string" ||
      !MOD_ID_RE.test(modIdA) ||
      !MOD_ID_RE.test(modIdB)
    ) {
      return res.status(400).json({
        error: "modIdA and modIdB are required and must be valid mod IDs",
        code: ErrorCode.MODS_IGNORED_PAIR_INVALID_IDS,
      });
    }
    if (modIdA === modIdB) {
      return res.status(400).json({
        error: "modIdA and modIdB must differ",
        code: ErrorCode.MODS_IGNORED_PAIR_SAME_ID,
      });
    }
    const safeReason = typeof reason === "string" ? reason.slice(0, 200) : null;
    const entry = await addIgnoredModPair(modIdA, modIdB, safeReason);
    if (!entry)
      return res.status(400).json({
        error: "Invalid pair",
        code: ErrorCode.MODS_IGNORED_PAIR_INVALID,
      });
    res.json({ success: true, pair: entry });
  } catch (error) {
    log.error(`Failed to add ignored mod pair: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/ignored-pairs", async (req, res) => {
  try {
    const { modIdA, modIdB } = req.body || {};
    if (
      typeof modIdA !== "string" ||
      typeof modIdB !== "string" ||
      !MOD_ID_RE.test(modIdA) ||
      !MOD_ID_RE.test(modIdB)
    ) {
      return res.status(400).json({
        error: "modIdA and modIdB are required",
        code: ErrorCode.MODS_IGNORED_PAIR_IDS_REQUIRED,
      });
    }
    const removed = await removeIgnoredModPair(modIdA, modIdB);
    if (!removed)
      return res.status(404).json({
        error: "Pair not found in ignore list",
        code: ErrorCode.MODS_IGNORED_PAIR_NOT_FOUND,
      });
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to remove ignored mod pair: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/check-updates", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const result = await modChecker.checkForUpdates();
    res.json(result);
  } catch (error) {
    log.error(`Failed to check for updates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/server-mods", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const mods = await serverManager.getModList();
    res.json({ mods });
  } catch (error) {
    log.error(`Failed to get server mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/check-rcon", async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.checkModsNeedUpdate();
    res.json(result);
  } catch (error) {
    log.error(`Failed to check mods via RCON: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/start", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const started = modChecker.start();
    if (!started) {
      return res.status(400).json({
        success: false,
        error:
          "Mod checker could not start. Configure a valid Workshop ACF path first.",
        code: ErrorCode.MODS_START_ACF_PATH_NOT_SET,
      });
    }
    res.json({ success: true, message: "Mod checker started" });
  } catch (error) {
    log.error(`Failed to start mod checker: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/stop", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    modChecker.stop();
    res.json({ success: true, message: "Mod checker stopped" });
  } catch (error) {
    log.error(`Failed to stop mod checker: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put("/interval", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const { intervalMs } = req.body || {};

    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 60000 ||
      intervalMs > 120 * 60 * 1000 ||
      intervalMs % 60000 !== 0
    ) {
      return res.status(400).json({
        error:
          "Interval must be a whole number of minutes from 60000ms to 7200000ms",
        code: ErrorCode.MODS_CHECK_INTERVAL_INVALID,
      });
    }

    await modChecker.setCheckInterval(intervalMs);
    res.json({
      success: true,
      message: `Check interval set to ${intervalMs}ms`,
    });
  } catch (error) {
    log.error(`Failed to set check interval: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/auto-restart", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        error: "`enabled` must be a boolean",
        code: ErrorCode.MODS_AUTO_RESTART_ENABLED_REQUIRED,
      });
    }

    if (enabled) {
      await modChecker.setUpdateCallback(async (updatedMods) => {
        const handled = await modChecker.handleModUpdate(updatedMods);
        if (!handled?.success) {
          log.warn(
            `Mod update handling failed: ${handled?.error || handled?.message || "unknown error"}`,
          );
        }
        return handled;
      });
    } else {
      await modChecker.setUpdateCallback(null);
    }

    res.json({ success: true, autoRestart: enabled });
  } catch (error) {
    log.error(`Failed to configure auto-restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put("/restart-options", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const {
      warningMinutes,
      delayIfPlayersOnline,
      maxDelayMinutes,
      checkInterval,
    } = req.body || {};

    const inRange = (v, min, max) =>
      parseBoundedInteger(v, null, min, max) !== null;
    if (warningMinutes !== undefined && !inRange(warningMinutes, 0, 30)) {
      return res.status(400).json({
        error: "warningMinutes must be a whole number from 0 to 30",
        code: ErrorCode.MODS_RESTART_WARNING_MINUTES_INVALID,
      });
    }
    if (maxDelayMinutes !== undefined && !inRange(maxDelayMinutes, 5, 120)) {
      return res.status(400).json({
        error: "maxDelayMinutes must be a whole number from 5 to 120",
        code: ErrorCode.MODS_RESTART_MAX_DELAY_MINUTES_INVALID,
      });
    }
    if (
      checkInterval !== undefined &&
      (!inRange(checkInterval, 60_000, 120 * 60 * 1000) ||
        parseBoundedInteger(checkInterval, null, 60_000, 120 * 60 * 1000) %
          60_000 !==
          0)
    ) {
      return res.status(400).json({
        error:
          "checkInterval must be a whole number of minutes from 60000ms to 7200000ms",
        code: ErrorCode.MODS_RESTART_CHECK_INTERVAL_INVALID,
      });
    }
    if (
      delayIfPlayersOnline !== undefined &&
      typeof delayIfPlayersOnline !== "boolean"
    ) {
      return res
        .status(400)
        .json({
          error: "delayIfPlayersOnline must be a boolean",
          code: ErrorCode.MODS_RESTART_DELAY_IF_PLAYERS_ONLINE_INVALID,
        });
    }

    await modChecker.setRestartOptions({
      warningMinutes,
      delayIfPlayersOnline,
      maxDelayMinutes,
      checkInterval,
    });

    const status = await modChecker.getStatus();
    res.json({
      success: true,
      options: {
        warningMinutes: status.restartWarningMinutes,
        delayIfPlayersOnline: status.delayIfPlayersOnline,
        maxDelayMinutes: status.maxDelayMinutes,
        checkInterval: status.checkInterval,
      },
    });
  } catch (error) {
    log.error(`Failed to set restart options: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/workshop-status", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    const status = await modChecker.getStatus();

    res.json({
      success: true,
      configured: status.workshopAcfConfigured,
      workshopAcfPath: status.workshopAcfPath,
      message: status.workshopAcfConfigured
        ? "Workshop ACF file found - mod updates can be detected automatically"
        : "Workshop ACF file not found - ensure server install path is correct",
    });
  } catch (error) {
    log.error(`Failed to get workshop status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/cancel-pending-restart", async (req, res) => {
  try {
    const modChecker = getModChecker(req, res);
    if (!modChecker) return;

    if (!modChecker.pendingRestart) {
      return res.json({
        success: false,
        message: "No pending restart to cancel",
      });
    }

    modChecker.cancelPendingRestart();
    res.json({ success: true, message: "Pending restart cancelled" });
  } catch (error) {
    log.error(`Failed to cancel pending restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sync-from-server", async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      log.warn("sync-from-server: Server config path not set");
      return res.json({
        success: false,
        message:
          "Server config path not set. Please configure the server first.",
        synced: 0,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    log.info(`sync-from-server: Looking for config at ${iniPath}`);

    if (!fs.existsSync(iniPath)) {
      log.warn(`sync-from-server: Config file not found at ${iniPath}`);
      return res.json({
        success: false,
        message: `Server config not found at ${iniPath}. Start the server once first.`,
        synced: 0,
      });
    }

    const content = readTextFile(iniPath);
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);

    const modIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];
    const workshopIds = workshopMatch?.[1]?.split(";").filter(Boolean) || [];

    log.info(
      `sync-from-server: Found ${modIds.length} mod IDs and ${workshopIds.length} workshop IDs`,
    );

    if (workshopIds.length === 0) {
      return res.json({
        success: true,
        message:
          "No mods found in server configuration (WorkshopItems is empty)",
        synced: 0,
      });
    }

    const PZ_APP_ID = 108600;
    const modChecker = req.app.get("modChecker");
    let steamInfo = new Map();
    const nonModTypes = new Set();
    if (modChecker) {
      try {
        steamInfo = await modChecker.fetchSteamTimestamps(workshopIds);
        for (const [id, info] of steamInfo) {
          if (info.creator_app_id && info.creator_app_id !== PZ_APP_ID) {
            nonModTypes.add(id);
            log.info(
              `sync-from-server: Filtering "${info.title || id}" (creator_app_id: ${info.creator_app_id}, not a PZ mod)`,
            );
          }
        }
      } catch (e) {
        log.warn(
          `sync-from-server: Steam API lookup failed, proceeding without type filter: ${e.message}`,
        );
      }
    }

    let synced = 0;
    let skippedIgnored = 0;
    let skippedNonMod = 0;
    for (let i = 0; i < workshopIds.length; i++) {
      try {
        const workshopId = workshopIds[i];
        if (nonModTypes.has(workshopId)) {
          skippedNonMod++;
          continue;
        }
        if (await isModIgnored(workshopId)) {
          skippedIgnored++;
          continue;
        }
        const nameFromDisk = modChecker?.resolveModNameFromDisk(workshopId);
        const steamTitle = steamInfo.get(workshopId)?.title;
        const modName =
          steamTitle || nameFromDisk || `Workshop Mod ${workshopId}`;
        await addTrackedMod(workshopId, modName);
        synced++;
      } catch (e) {
        log.warn(`Failed to sync mod ${workshopIds[i]}: ${e.message}`);
      }
    }

    const parts = [];
    if (skippedIgnored > 0) parts.push(`${skippedIgnored} ignored`);
    if (skippedNonMod > 0)
      parts.push(`${skippedNonMod} non-mod items filtered`);
    const message =
      parts.length > 0
        ? `Synced ${synced} mods from server config (${parts.join(", ")})`
        : `Synced ${synced} mods from server config`;
    res.json({
      success: true,
      message,
      synced,
      skippedIgnored,
      skippedNonMod,
      iniPath,
    });
  } catch (error) {
    log.error(`Failed to sync mods from server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/clear-updates", async (req, res) => {
  try {
    await clearModUpdates();
    res.json({ success: true, message: "Update flags cleared" });
  } catch (error) {
    log.error(`Failed to clear mod updates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/collection/diff", async (req, res) => {
  try {
    const tracked = await getTrackedMods();
    const ids = tracked.map((m) => String(m.workshop_id));
    const diff = await computeCollectionDiff(ids);
    const configuredWorkshopIds = new Set();
    let serverConfigRead = false;
    try {
      const serverConfigPath = await getServerConfigPath();
      const serverName = await getServerName();
      const sanitizedServerName = path.basename(serverName || "");
      if (
        serverConfigPath &&
        sanitizedServerName === serverName &&
        !serverName.includes("..")
      ) {
        const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
        if (fs.existsSync(iniPath)) {
          const workshopMatch = readTextFile(iniPath).match(
            /^WorkshopItems=(.*)$/m,
          );
          for (const id of workshopMatch?.[1]?.split(";") || []) {
            if (id) configuredWorkshopIds.add(id);
          }
          serverConfigRead = true;
        }
      }
    } catch (error) {
      serverConfigRead = false;
      log.debug(`Collection server membership check skipped: ${error.message}`);
    }

    let items = [];
    if (diff.ok) {
      const trackedNames = new Map(
        tracked.map((m) => {
          const workshopId = String(m.workshop_id);
          const name = typeof m.name === "string" ? m.name.trim() : "";
          const isPlaceholder = name === `Workshop Mod ${workshopId}`;
          return [workshopId, isPlaceholder ? null : name || null];
        }),
      );
      const inCollection = new Set(diff.inCollection.map(String));
      const allIds = new Set([
        ...trackedNames.keys(),
        ...inCollection,
        ...configuredWorkshopIds,
      ]);
      const needTitles = [...allIds].filter((id) => !trackedNames.get(id));
      const titleMap =
        needTitles.length > 0
          ? await fetchPublishedFileTitles(needTitles)
          : new Map();
      items = [...allIds].map((id) => {
        const inTracked = trackedNames.has(id);
        const inColl = inCollection.has(id);
        const inServer = configuredWorkshopIds.has(id);
        const present = serverConfigRead ? inServer : inTracked;
        let status;
        if (present && inColl) status = "synced";
        else if (present && !inColl) status = "to-add";
        else if (!present && inColl) status = "collection-only";
        else status = "tracked-only";
        return {
          workshopId: id,
          name: trackedNames.get(id) || titleMap.get(id) || null,
          status,
          inTracked,
          inCollection: inColl,
          inServer,
        };
      });
      const order = {
        "to-add": 0,
        "collection-only": 1,
        "tracked-only": 2,
        synced: 3,
      };
      items.sort((a, b) => {
        if (order[a.status] !== order[b.status])
          return order[a.status] - order[b.status];
        const an = (a.name || a.workshopId).toLowerCase();
        const bn = (b.name || b.workshopId).toLowerCase();
        return an.localeCompare(bn);
      });
    }

    const { sessionId: sidVal, loginSecure: lsVal } =
      await getSteamSessionCredentials();
    const looksMasked = (v) =>
      typeof v === "string" && (v.startsWith("••••••••") || /^[•*]+$/.test(v));
    const hasCredentials =
      typeof sidVal === "string" &&
      sidVal.trim().length >= 8 &&
      !looksMasked(sidVal) &&
      typeof lsVal === "string" &&
      lsVal.trim().length >= 16 &&
      !looksMasked(lsVal);

    let tokenExpiry = null;
    let tokenExpired = false;
    if (hasCredentials && lsVal) {
      try {
        const decoded = decodeURIComponent(lsVal.trim());
        const jwtPart = decoded.split("||")[1];
        if (jwtPart) {
          const payload = JSON.parse(
            Buffer.from(jwtPart.split(".")[1], "base64").toString(),
          );
          if (payload.exp) {
            tokenExpiry = payload.exp * 1000;
            tokenExpired = Date.now() > tokenExpiry;
          }
        }
      } catch {
        /* non-JWT format or decode failure — ignore */
      }
    }

    res.json({
      ...diff,
      items,
      collectionId: (await getSetting("workshopCollectionId")) || null,
      autoSync: !!(await getSetting("workshopCollectionAutoSync")),
      hasCredentials,
      tokenExpiry,
      tokenExpired,
      trackedCount: ids.length,
      serverConfigRead,
    });
  } catch (error) {
    log.error(`Collection diff failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/collection/items", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId) {
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    }
    const workshopId = String(req.body?.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const r = await addItemToCollection(collectionId, workshopId);
    if (!r.ok)
      return res
        .status(502)
        .json({ error: r.error || "Steam rejected the change" });
    res.json({ ok: true, workshopId, action: "add" });
  } catch (error) {
    log.error(`Collection add failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/collection/items/:workshopId", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId) {
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    }
    const workshopId = String(req.params.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const r = await removeItemFromCollection(collectionId, workshopId);
    if (!r.ok)
      return res
        .status(502)
        .json({ error: r.error || "Steam rejected the change" });
    res.json({ ok: true, workshopId, action: "remove" });
  } catch (error) {
    log.error(`Collection remove failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/collection/tracking/:workshopId", async (req, res) => {
  try {
    const workshopId = String(req.params.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(workshopId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }
    const removed = await removeTrackedMod(workshopId);
    res.json({
      ok: true,
      workshopId,
      removed,
      message: removed
        ? "Mod is no longer tracked; Steam collection and server configuration were unchanged"
        : "Mod was not tracked",
    });
  } catch (error) {
    log.error(`Collection tracking removal failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/collection/sync", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId) {
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    }
    const tracked = await getTrackedMods();
    const trackedIds = tracked.map((m) => String(m.workshop_id));
    const diff = await computeCollectionDiff(trackedIds);
    if (!diff.ok) {
      return res
        .status(502)
        .json({ error: diff.error || "Could not read collection" });
    }

    const added = [];
    const errors = [];
    let staleSession = false;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const STALE_RE = /session expired|HTTP 302|HTTP 401|HTTP 403/i;

    for (const id of diff.toAdd) {
      const r = await addItemToCollection(collectionId, id);
      if (r.ok) added.push(id);
      else {
        errors.push({ action: "add", id, error: r.error });
        if (r.error && STALE_RE.test(r.error)) {
          staleSession = true;
          break;
        }
      }
      await sleep(300);
    }
    const failedTitles = await fetchPublishedFileTitles(errors.map(({ id }) => id));
    const detailedErrors = errors.map((entry) => ({
      ...entry,
      title: failedTitles.get(entry.id) || null,
    }));
    res.json({
      success: detailedErrors.length === 0,
      collectionId,
      added,
      removed: [],
      errors: detailedErrors,
      staleSession,
      message:
        detailedErrors.length === 0
          ? `Synced \u2014 added ${added.length}`
          : staleSession
            ? "Steam session expired \u2014 paste fresh cookies and try again"
            : `Steam rejected ${detailedErrors.length} item${detailedErrors.length !== 1 ? "s" : ""}`,
    });
  } catch (error) {
    log.error(`Collection sync failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/collection/test", async (req, res) => {
  try {
    const collectionId = await getSetting("workshopCollectionId");
    if (!collectionId)
      return res.status(400).json({
        error: "Collection ID not configured",
        code: ErrorCode.MODS_COLLECTION_ID_NOT_CONFIGURED,
      });
    const { sessionId, loginSecure } = await getSteamSessionCredentials();
    if (!sessionId || !loginSecure)
      return res
        .status(400)
        .json({
          error: "Steam session cookies not configured",
          code: ErrorCode.MODS_STEAM_SESSION_COOKIES_NOT_CONFIGURED,
        });

    const contents = await getCollectionContents(collectionId);
    if (!contents.ok)
      return res
        .status(502)
        .json({ error: contents.error || "Could not read collection" });

    res.json({
      success: true,
      collectionId,
      title: contents.title,
      itemCount: contents.items.length,
      writeVerified: false,
      message: contents.title
        ? `Collection "${contents.title}" found (${contents.items.length} items). Write access is verified on first sync.`
        : `Collection found (${contents.items.length} items). Write access is verified on first sync.`,
    });
  } catch (error) {
    log.error(`Collection test failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/collection/browsers", async (req, res) => {
  try {
    const info = listAvailableBrowsers();
    res.json(info);
  } catch (error) {
    log.error(`List browsers failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/collection/extract-cookies", async (req, res) => {
  try {
    const browser = String(req.body?.browser || "")
      .toLowerCase()
      .trim();
    const allowed = ["firefox", "chrome", "edge", "brave"];
    if (!allowed.includes(browser)) {
      return res.status(400).json({
        error: "Invalid browser. Must be one of: " + allowed.join(", "),
        code: ErrorCode.MODS_INVALID_BROWSER,
        params: sanitizeErrorParams({ browsers: allowed.join(", ") }),
      });
    }
    const result = await extractSteamCookies(browser);
    if (!result.ok) {
      return res.status(200).json(result);
    }
    await setSteamSessionCredentials(result.sessionid, result.steamLoginSecure);
    res.json({
      ok: true,
      browser: result.browser,
      saved: true,
      notes: result.notes,
    });
  } catch (error) {
    log.error(`Extract cookies failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/collection/save-cookies", async (req, res) => {
  try {
    const sessionid =
      typeof req.body?.sessionid === "string" ? req.body.sessionid.trim() : "";
    const loginSecure =
      typeof req.body?.steamLoginSecure === "string"
        ? req.body.steamLoginSecure.trim()
        : "";

    if (!sessionid || !loginSecure) {
      return res
        .status(400)
        .json({
          error: "Both sessionid and steamLoginSecure are required",
          code: ErrorCode.MODS_COOKIE_VALUES_REQUIRED,
        });
    }
    const HAS_CONTROL = /[\r\n\0;]/;
    if (HAS_CONTROL.test(sessionid) || HAS_CONTROL.test(loginSecure)) {
      return res
        .status(400)
        .json({
          error: "Cookie values contain forbidden control characters",
          code: ErrorCode.MODS_COOKIE_VALUES_CONTROL_CHARS,
        });
    }
    if (sessionid.length > 4096 || loginSecure.length > 4096) {
      return res
        .status(400)
        .json({
          error: "Cookie values are unexpectedly long",
          code: ErrorCode.MODS_COOKIE_VALUES_TOO_LONG,
        });
    }

    await setSteamSessionCredentials(sessionid, loginSecure);

    log.info(
      `Steam cookies updated via manual entry (user: ${req.user?.username || "unknown"})`,
    );
    res.json({ ok: true, message: "Cookies saved" });
  } catch (error) {
    log.error(`Saving Steam cookies failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/import-collection", async (req, res) => {
  try {
    const { collectionUrl } = req.body;

    if (!collectionUrl) {
      return res
        .status(400)
        .json({
          error: "Collection URL or ID is required",
          code: ErrorCode.MODS_IMPORT_COLLECTION_URL_REQUIRED,
        });
    }

    let collectionId = collectionUrl;
    const urlMatch = collectionUrl.match(/id=(\d+)/);
    if (urlMatch) {
      collectionId = urlMatch[1];
    }

    if (!/^\d{1,15}$/.test(collectionId)) {
      return res.status(400).json({
        error: "Invalid collection ID",
        code: ErrorCode.MODS_IMPORT_COLLECTION_ID_INVALID,
      });
    }

    log.info(`Fetching collection details for ID: ${collectionId}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let collectionResponse;
    try {
      collectionResponse = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            collectioncount: "1",
            "publishedfileids[0]": collectionId,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error.name === "AbortError") {
        return res.status(504).json({
          error: "Steam collection lookup timed out. Please try again.",
          code: ErrorCode.MODS_IMPORT_COLLECTION_TIMEOUT,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!collectionResponse.ok) {
      throw new Error(`Steam API returned ${collectionResponse.status}`);
    }

    const collectionData = await collectionResponse.json();

    if (!collectionData.response?.collectiondetails?.[0]) {
      return res.status(404).json({
        error: "Collection not found",
        code: ErrorCode.MODS_IMPORT_COLLECTION_NOT_FOUND,
      });
    }

    const collection = collectionData.response.collectiondetails[0];

    if (collection.result !== 1) {
      return res
        .status(404)
        .json({
          error: "Collection not found or is private",
          code: ErrorCode.MODS_IMPORT_COLLECTION_PRIVATE,
        });
    }

    const WORKSHOP_FILE_TYPE_COLLECTION = 2;
    const children = collection.children || [];
    const subCollectionIds = children
      .filter((c) => Number(c.filetype) === WORKSHOP_FILE_TYPE_COLLECTION)
      .map((c) => c.publishedfileid);
    const modIds = children
      .filter((c) => Number(c.filetype) !== WORKSHOP_FILE_TYPE_COLLECTION)
      .map((c) => c.publishedfileid);

    if (modIds.length === 0) {
      return res.json({
        success: true,
        message: "Collection is empty",
        mods: [],
        subCollectionIds,
      });
    }

    const modFormData = new URLSearchParams();
    modFormData.append("itemcount", modIds.length.toString());
    modIds.forEach((id, index) => {
      modFormData.append(`publishedfileids[${index}]`, id);
    });

    const modsAbort = new AbortController();
    const modsTimer = setTimeout(() => modsAbort.abort(), 15000);
    let modsResponse;
    try {
      modsResponse = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: modFormData,
          signal: modsAbort.signal,
        },
      );
    } finally {
      clearTimeout(modsTimer);
    }

    if (!modsResponse.ok) {
      throw new Error(`Steam API returned ${modsResponse.status}`);
    }

    const modsData = await modsResponse.json();
    const allDetails = modsData.response?.publishedfiledetails || [];

    const mods = allDetails
      .filter((m) => m.result === 1)
      .map((m) => ({
        workshopId: m.publishedfileid,
        name: m.title,
        description: m.description?.substring(0, 200),
        tags: m.tags?.map((t) => t.tag) || [],
        isMap:
          m.tags?.some(
            (t) =>
              t.tag?.toLowerCase() === "map" || t.tag?.toLowerCase() === "maps",
          ) || false,
      }));

    const resolvedIds = new Set(mods.map((m) => m.workshopId));
    const skippedModIds = modIds.filter((id) => !resolvedIds.has(id));

    log.info(
      `Found ${mods.length} mods in collection ${collectionId}` +
        (subCollectionIds.length > 0
          ? ` (${subCollectionIds.length} sub-collection${subCollectionIds.length === 1 ? "" : "s"} skipped)`
          : "") +
        (skippedModIds.length > 0
          ? ` (${skippedModIds.length} mod lookup${skippedModIds.length === 1 ? "" : "s"} failed: ${skippedModIds.join(", ")})`
          : ""),
    );

    res.json({
      success: true,
      collectionId,
      totalMods: mods.length,
      mods,
      subCollectionIds,
      skippedModIds,
    });
  } catch (error) {
    log.error(`Failed to import collection: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/get-mod-info", async (req, res) => {
  try {
    const { workshopId } = req.body;

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    const workshopIdStr = String(workshopId);
    if (!/^\d{1,15}$/.test(workshopIdStr)) {
      return res.status(400).json({
        error: "Invalid Workshop ID format",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_FORMAT,
      });
    }

    const infoAbort = new AbortController();
    const infoTimer = setTimeout(() => infoAbort.abort(), 15000);
    let response;
    try {
      response = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            itemcount: "1",
            "publishedfileids[0]": workshopId,
          }),
          signal: infoAbort.signal,
        },
      );
    } finally {
      clearTimeout(infoTimer);
    }

    if (!response.ok) {
      throw new Error(`Steam API returned ${response.status}`);
    }

    const data = await response.json();
    const modInfo = data.response?.publishedfiledetails?.[0];

    if (!modInfo || modInfo.result !== 1) {
      return res.status(404).json({
        error: "Mod not found",
        code: ErrorCode.MODS_GET_MOD_INFO_NOT_FOUND,
      });
    }

    res.json({
      workshopId: modInfo.publishedfileid,
      name: modInfo.title,
      description: modInfo.description?.substring(0, 500),
      tags: modInfo.tags?.map((t) => t.tag) || [],
      isMap:
        modInfo.tags?.some(
          (t) =>
            t.tag?.toLowerCase() === "map" || t.tag?.toLowerCase() === "maps",
        ) || false,
      timeUpdated: modInfo.time_updated,
      timeCreated: modInfo.time_created,
    });
  } catch (error) {
    log.error(`Failed to get mod info: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/write-to-ini", async (req, res) => {
  try {
    const { mods, mapFolders } = req.body;
    log.info(
      `POST /write-to-ini: ${mods?.length || 0} mods, ${mapFolders?.length || 0} map folders`,
    );

    if (!mods || !Array.isArray(mods)) {
      return res.status(400).json({
        error: "Mods array is required",
        code: ErrorCode.MODS_WRITE_TO_INI_MODS_ARRAY_REQUIRED,
      });
    }

    for (const m of mods) {
      if (m.workshopId && !/^\d{1,15}$/.test(String(m.workshopId))) {
        const workshopId = String(m.workshopId).substring(0, 20);
        return res.status(400).json({
          error: `Invalid Workshop ID: ${workshopId}`,
          code: ErrorCode.MODS_INVALID_WORKSHOP_ID_TEMPLATE,
          params: sanitizeErrorParams({ workshopId }),
        });
      }
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please configure the server first.",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET_GUIDANCE,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error:
          "Server config file not found. Start the server once first to generate the config file.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_GUIDANCE,
      });
    }

    const resolvedMods = [];
    let autoDetectedCount = 0;

    for (const m of mods) {
      let modId = m.modId;
      const workshopIdStr = String(m.workshopId);

      if (modId && /^\d{1,15}$/.test(modId)) {
        if (serverPath) {
          const detectedId = findModIdFromWorkshop(modId, serverPath);
          if (detectedId) {
            modId = detectedId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from local files: ${detectedId} for workshop ${m.workshopId}`,
            );
          }
        }
        if (/^\d{1,15}$/.test(modId)) {
          const steamModId = await fetchModIdFromWorkshop(workshopIdStr);
          if (steamModId) {
            modId = steamModId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${m.workshopId}`,
            );
          }
        }
      }
      // Also try if no modId at all
      else if (!modId) {
        if (serverPath) {
          const detectedId = findModIdFromWorkshop(workshopIdStr, serverPath);
          if (detectedId) {
            modId = detectedId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from local files: ${detectedId} for workshop ${m.workshopId}`,
            );
          }
        }
        if (!modId) {
          const steamModId = await fetchModIdFromWorkshop(workshopIdStr);
          if (steamModId) {
            modId = steamModId;
            autoDetectedCount++;
            log.info(
              `Auto-detected mod ID from Steam Workshop: ${steamModId} for workshop ${m.workshopId}`,
            );
          }
        }
      }

      if (modId && looksLikeWorkshopId(String(modId))) {
        log.warn(
          `Dropping unresolved numeric modId "${modId}" for workshop ${m.workshopId} (would have polluted Mods=)`,
        );
        modId = null;
      }

      resolvedMods.push({
        workshopId: m.workshopId,
        modId: modId || null,
      });
    }

    const modIdList = sanitizeModIdList(
      resolvedMods.map((m) => m.modId).filter(Boolean),
    );
    const workshopIdList = sanitizeIniList(
      resolvedMods.map((m) => m.workshopId).filter(Boolean),
    );
    const unresolvedWorkshopIds = resolvedMods
      .filter((m) => m.workshopId && !m.modId)
      .map((m) => m.workshopId);

    let detectedMapFolders = mapFolders || [];
    if (serverPath && (!mapFolders || mapFolders.length === 0)) {
      for (const m of mods) {
        const workshopIdStr = String(m.workshopId);
        const modMapFolders = findMapFoldersFromWorkshop(
          workshopIdStr,
          serverPath,
        );
        for (const folder of modMapFolders) {
          if (!detectedMapFolders.includes(folder)) {
            detectedMapFolders.push(folder);
            log.info(
              `Auto-detected map folder: ${folder} from workshop ${workshopIdStr}`,
            );
          }
        }
      }
    }

    let mapList = "Muldraugh, KY";
    if (detectedMapFolders && detectedMapFolders.length > 0) {
      mapList = `${sanitizeIniList(detectedMapFolders)};Muldraugh, KY`;
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      if (content.match(/^[ \t]*Mods[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${modIdList}`);
      } else {
        content += `\nMods=${modIdList}`;
      }

      if (content.match(/^[ \t]*WorkshopItems[ \t]*=.*/m)) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          `WorkshopItems=${workshopIdList}`,
        );
      } else {
        content += `\nWorkshopItems=${workshopIdList}`;
      }

      if (detectedMapFolders && detectedMapFolders.length > 0) {
        if (content.match(/^[ \t]*Map[ \t]*=.*/m)) {
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, `Map=${mapList}`);
        } else {
          content += `\nMap=${mapList}`;
        }
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    log.info(
      `Wrote ${mods.length} mods to ${iniPath} (${autoDetectedCount} mod IDs auto-detected, ${detectedMapFolders.length} map folders)`,
    );

    res.json({
      success: true,
      message: `Successfully configured ${mods.length} mods in server config.${autoDetectedCount > 0 ? ` (${autoDetectedCount} mod IDs auto-detected)` : ""}${detectedMapFolders.length > 0 ? ` Map folders: ${detectedMapFolders.join(", ")}` : ""}${unresolvedWorkshopIds.length > 0 ? ` WARNING: ${unresolvedWorkshopIds.length} mod ID(s) could not be auto-detected and were subscribed but NOT enabled: ${unresolvedWorkshopIds.join(", ")}` : ""}`,
      iniPath,
      modsConfigured: mods.length,
      autoDetectedModIds: autoDetectedCount,
      unresolvedModIds: unresolvedWorkshopIds,
      modIds: modIdList,
      workshopItems: workshopIdList,
      mapList,
      mapFolders: detectedMapFolders,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to write mods to ini: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/current-config", async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.json({
        configured: false,
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
        modIds: [],
        workshopIds: [],
        totalMods: 0,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.json({
        configured: false,
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
        modIds: [],
        workshopIds: [],
        totalMods: 0,
      });
    }

    const content = readTextFile(iniPath);

    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);

    const modIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];
    const workshopIds = workshopMatch?.[1]?.split(";").filter(Boolean) || [];
    const maps = mapMatch?.[1]?.split(";").filter(Boolean) || ["Muldraugh, KY"];

    const duplicateKeys = findDuplicateIniKeys(content);

    const serverPath = await getServerPath();
    const modIdSet = new Set(modIds);
    const workshopModMap = {};
    if (serverPath) {
      for (const wsId of workshopIds) {
        const details = getModDetailsFromWorkshop(wsId, serverPath);
        workshopModMap[wsId] = details.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          enabled: modIdSet.has(m.id),
          require: m.require?.length ? m.require : undefined,
        }));
      }
    }

    res.json({
      configured: true,
      modIds,
      workshopIds,
      maps,
      totalMods: modIds.length,
      iniPath,
      workshopModMap,
      duplicateKeys,
    });
  } catch (error) {
    log.error(`Failed to get current mod config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/toggle-mod-id", async (req, res) => {
  try {
    const { modId, enabled } = req.body;

    if (!modId || typeof modId !== "string") {
      return res.status(400).json({
        error: "modId is required",
        code: ErrorCode.MODS_TOGGLE_MOD_ID_REQUIRED,
      });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        error: "enabled (boolean) is required",
        code: ErrorCode.MODS_TOGGLE_ENABLED_REQUIRED,
      });
    }
    if (/[\r\n;=]/.test(modId) || modId.length > 200) {
      return res.status(400).json({
        error: "Invalid mod ID format",
        code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const serverPath = await getServerPath();

    const result = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      let currentModIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];
      const currentWorkshopIds =
        content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m)?.[1]
          ?.split(";")
          .filter(Boolean) || [];

      if (
        enabled &&
        looksLikeWorkshopId(modId) &&
        !isModIdVerifiedOnDisk(modId, currentWorkshopIds, serverPath)
      ) {
        return { rejected: true };
      }

      if (enabled) {
        if (!currentModIds.includes(modId)) {
          currentModIds.push(modId);
        }
      } else {
        currentModIds = currentModIds.filter((id) => id !== modId);
      }

      const newModList = sanitizeModIdListWithDiskBypass(
        currentModIds,
        currentWorkshopIds,
        serverPath,
      );
      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { totalMods: currentModIds.length, backupWarning };
    });

    if (result.rejected) {
      return res.status(400).json({
        error:
          "That looks like a Steam Workshop ID, not a mod ID. Workshop IDs (numeric) belong in WorkshopItems=, not Mods=.",
        code: ErrorCode.MODS_TOGGLE_WORKSHOP_ID_IN_MODID,
      });
    }

    log.info(
      `Toggled mod ID "${modId}" ${enabled ? "ON" : "OFF"} in ${iniPath}`,
    );

    res.json({
      success: true,
      modId,
      enabled,
      totalMods: result.totalMods,
      ...(result.backupWarning ? { backupWarning: result.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to toggle mod ID: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/batch-toggle-mod-ids", async (req, res) => {
  try {
    const { changes } = req.body;

    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({
        error: "changes array is required",
        code: ErrorCode.MODS_BATCH_TOGGLE_CHANGES_REQUIRED,
      });
    }
    if (changes.length > 500) {
      return res.status(400).json({
        error: "Too many changes (max 500)",
        code: ErrorCode.MODS_BATCH_TOGGLE_TOO_MANY,
      });
    }

    for (const change of changes) {
      if (!change.modId || typeof change.modId !== "string") {
        return res.status(400).json({
          error: "Each change must have a modId string",
          code: ErrorCode.MODS_BATCH_TOGGLE_MODID_STRING_REQUIRED,
        });
      }
      if (typeof change.enabled !== "boolean") {
        return res.status(400).json({
          error: "Each change must have an enabled boolean",
          code: ErrorCode.MODS_BATCH_TOGGLE_ENABLED_BOOLEAN_REQUIRED,
        });
      }
      if (/[\r\n;=]/.test(change.modId) || change.modId.length > 200) {
        const modId = change.modId.substring(0, 50);
        return res.status(400).json({
          error: `Invalid mod ID format: ${modId}`,
          code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT_TEMPLATE,
          params: sanitizeErrorParams({ modId }),
        });
      }
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const serverPath = await getServerPath();

    const result = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      let currentModIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];
      const currentWorkshopIds =
        content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m)?.[1]
          ?.split(";")
          .filter(Boolean) || [];

      const badEnables = changes.filter(
        (c) =>
          c.enabled &&
          looksLikeWorkshopId(c.modId) &&
          !isModIdVerifiedOnDisk(c.modId, currentWorkshopIds, serverPath),
      );
      if (badEnables.length > 0) {
        return { rejectedCount: badEnables.length };
      }

      for (const { modId, enabled } of changes) {
        if (enabled) {
          if (!currentModIds.includes(modId)) {
            currentModIds.push(modId);
          }
        } else {
          currentModIds = currentModIds.filter((id) => id !== modId);
        }
      }

      const newModList = sanitizeModIdListWithDiskBypass(
        currentModIds,
        currentWorkshopIds,
        serverPath,
      );
      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { totalMods: currentModIds.length, backupWarning };
    });

    if (result.rejectedCount) {
      return res.status(400).json({
        error: `Refusing to add ${result.rejectedCount} workshop-ID-shaped entr${result.rejectedCount === 1 ? "y" : "ies"} to Mods= (those belong in WorkshopItems=).`,
        code: ErrorCode.MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS,
        params: sanitizeErrorParams({ count: result.rejectedCount }),
      });
    }

    log.info(`Batch toggled ${changes.length} mod IDs in ${iniPath}`);

    res.json({
      success: true,
      changesApplied: changes.length,
      totalMods: result.totalMods,
      ...(result.backupWarning ? { backupWarning: result.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to batch toggle mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/add-to-ini", async (req, res) => {
  try {
    const { workshopId, modId } = req.body;

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error:
          "Server config path not set. Please configure the server first in Settings.",
        code: ErrorCode.MODS_ADD_TO_INI_CONFIG_PATH_NOT_SET,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error:
          "Server config file not found. Start the server once first to generate the config file.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_GUIDANCE,
      });
    }

    let detectedModId = modId;
    let detectionSource = "provided";
    const serverPath = await getServerPath();

    if (!detectedModId) {
      if (serverPath) {
        detectedModId = findModIdFromWorkshop(String(workshopId), serverPath);
        if (detectedModId) {
          detectionSource = "local-files";
          log.info(
            `Auto-detected mod ID from local files: ${detectedModId} for workshop ${workshopId}`,
          );
        }
      }

      if (!detectedModId) {
        detectedModId = await fetchModIdFromWorkshop(String(workshopId));
        if (detectedModId) {
          detectionSource = "steam-workshop";
          log.info(
            `Auto-detected mod ID from Steam Workshop: ${detectedModId} for workshop ${workshopId}`,
          );
        }
      }
    }

    let addedMapFolders = [];
    let modMapFolders = [];
    if (serverPath) {
      modMapFolders = findMapFoldersFromWorkshop(
        String(workshopId),
        serverPath,
      );
    }

    const result = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const currentWorkshopIds =
        workshopMatch?.[1]?.split(";").filter(Boolean) || [];
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentModIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];

      if (currentWorkshopIds.includes(String(workshopId))) {
        return { alreadyExists: true };
      }

      currentWorkshopIds.push(String(workshopId));
      const newWorkshopList = sanitizeIniList(currentWorkshopIds);

      if (detectedModId && !currentModIds.includes(detectedModId)) {
        currentModIds.push(detectedModId);
      }
      const newModList = sanitizeModIdList(currentModIds);

      if (workshopMatch) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          `WorkshopItems=${newWorkshopList}`,
        );
      } else {
        content += `\nWorkshopItems=${newWorkshopList}`;
      }

      if (detectedModId) {
        if (modsMatch) {
          content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${newModList}`);
        } else {
          content += `\nMods=${newModList}`;
        }
      }

      if (modMapFolders.length > 0) {
        const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
        let currentMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [
          "Muldraugh, KY",
        ];

        for (const folder of modMapFolders) {
          if (!currentMaps.includes(folder)) {
            currentMaps.unshift(folder);
            addedMapFolders.push(folder);
            log.info(`Added map folder: ${folder} for workshop ${workshopId}`);
          }
        }

        const newMapList = currentMaps.join(";");
        if (mapMatch) {
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, `Map=${newMapList}`);
        } else {
          content += `\nMap=${newMapList}`;
        }
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return {
        alreadyExists: false,
        totalWorkshopItems: currentWorkshopIds.length,
        backupWarning,
      };
    });

    if (result.alreadyExists) {
      return res.json({
        success: true,
        message: "Mod is already configured in the server",
        alreadyExists: true,
      });
    }

    log.info(
      `Added mod ${workshopId} to ${iniPath}${addedMapFolders.length > 0 ? ` with map folders: ${addedMapFolders.join(", ")}` : ""}`,
    );

    res.json({
      success: true,
      message: detectedModId
        ? `Mod added to server configuration${addedMapFolders.length > 0 ? ` with map folders: ${addedMapFolders.join(", ")}` : ""}`
        : "Workshop ID added (mod will be downloaded on server start)",
      workshopId,
      modId: detectedModId || null,
      autoDetected: !modId && !!detectedModId,
      detectionSource: detectedModId ? detectionSource : null,
      totalWorkshopItems: result.totalWorkshopItems,
      mapFoldersAdded: addedMapFolders,
      note: detectedModId
        ? undefined
        : 'Mod ID could not be auto-detected. You may need to add it manually or use "Sync Mod IDs" after the mod is downloaded.',
      ...(result.backupWarning ? { backupWarning: result.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to add mod to ini: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

async function fetchModIdFromWorkshop(workshopId) {
  try {
    const fetchAbort = new AbortController();
    const fetchTimer = setTimeout(() => fetchAbort.abort(), 15000);
    let response;
    try {
      response = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            itemcount: "1",
            "publishedfileids[0]": workshopId,
          }),
          signal: fetchAbort.signal,
        },
      );
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!response.ok) {
      log.warn(
        `Steam API returned ${response.status} for workshop ${workshopId}`,
      );
      return null;
    }

    const data = await response.json();
    const modInfo = data.response?.publishedfiledetails?.[0];

    if (!modInfo || modInfo.result !== 1) {
      log.warn(`Mod not found for workshop ${workshopId}`);
      return null;
    }

    const description = modInfo.description || "";
    const title = modInfo.title || "";

    let match = description.match(/Mod\s*ID\s*[:=]\s*([^\s\n\r\[\]<>]+)/i);
    if (match) {
      log.info(`Found Mod ID from "Mod ID:" pattern: ${match[1]}`);
      return match[1].trim();
    }

    match = description.match(/\bid\s*=\s*([^\s\n\r\[\]<>]+)/i);
    if (match) {
      log.info(`Found Mod ID from "id=" pattern: ${match[1]}`);
      return match[1].trim();
    }

    match = description.match(/\bMod\s*:\s*([A-Za-z0-9_-]+)/i);
    if (match && match[1].length > 3) {
      log.info(`Found Mod ID from "Mod:" pattern: ${match[1]}`);
      return match[1].trim();
    }

    match = description.match(
      /\[code\][\s\S]*?id\s*=\s*([^\s\n\r\[\]]+)[\s\S]*?\[\/code\]/i,
    );
    if (match) {
      log.info(`Found Mod ID from [code] block: ${match[1]}`);
      return match[1].trim();
    }

    match = description.match(/IDs\s*[:=]\s*([^\s\n\r\[\]<>]+)/i);
    if (match) {
      log.info(`Found Mod ID from "IDs:" pattern: ${match[1]}`);
      return match[1].trim();
    }


    const potentialId = title.replace(/[^a-zA-Z0-9_-]/g, "");
    if (
      potentialId === title &&
      potentialId.length > 3 &&
      potentialId.length < 30
    ) {
      log.info(`Using title as Mod ID (exact match): ${potentialId}`);
      return potentialId;
    }

    log.warn(
      `Could not extract Mod ID from workshop ${workshopId} description. Title: "${title}"`,
    );
    return null;
  } catch (error) {
    log.error(
      `Error fetching mod ID from workshop ${workshopId}: ${error.message}`,
    );
    return null;
  }
}

function getWorkshopPaths(workshopId, serverPath) {
  const home = os.homedir();
  const paths = [
    path.join(
      serverPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
    path.join(
      serverPath,
      "..",
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
    path.join(
      home,
      "Steam",
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
  ];
  if (process.platform !== "win32") {
    paths.push(
      path.join(
        home,
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
      path.join(
        home,
        ".steam",
        "steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
      path.join(
        home,
        ".var",
        "app",
        "com.valvesoftware.Steam",
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
    );
  }
  return paths;
}

function isValidMapFolder(mapFolderPath) {
  try {
    const files = fs.readdirSync(mapFolderPath);
    for (const file of files) {
      const lower = file.toLowerCase();
      if (
        lower.endsWith(".lotheader") ||
        lower === "objects.lua" ||
        lower.endsWith(".lotpack")
      ) {
        return true;
      }
      if (lower.startsWith("world_") || lower.startsWith("chunkdata_")) {
        return true;
      }
    }
    return false;
  } catch (e) {
    log.debug(`Error validating map folder ${mapFolderPath}: ${e.message}`);
    return false;
  }
}

function findMapFoldersFromWorkshop(workshopId, serverPath) {
  const mapFolders = [];
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);

  function scanMapsDir(mapsPath) {
    if (!fs.existsSync(mapsPath)) return;
    const mapEntries = fs.readdirSync(mapsPath, { withFileTypes: true });
    for (const mapEntry of mapEntries) {
      if (
        mapEntry.isDirectory() &&
        !mapFolders.includes(mapEntry.name) &&
        isValidMapFolder(path.join(mapsPath, mapEntry.name))
      ) {
        mapFolders.push(mapEntry.name);
        log.debug(
          `Found valid map folder: ${mapEntry.name} in workshop ${workshopId}`,
        );
      }
    }
  }

  for (const workshopPath of possiblePaths) {
    if (!fs.existsSync(workshopPath)) continue;

    const modsFolder = path.join(workshopPath, "mods");
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;

    try {
      if (fs.existsSync(searchPath)) {
        const entries = fs.readdirSync(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const entryPath = path.join(searchPath, entry.name);

          scanMapsDir(path.join(entryPath, "media", "maps"));

          try {
            const subEntries = fs.readdirSync(entryPath, {
              withFileTypes: true,
            });
            for (const sub of subEntries) {
              if (sub.isDirectory()) {
                scanMapsDir(path.join(entryPath, sub.name, "media", "maps"));
              }
            }
          } catch {
            // Ignore unreadable mod folders
          }
        }
      }

      scanMapsDir(path.join(workshopPath, "media", "maps"));

      if (mapFolders.length > 0) return mapFolders;
    } catch (e) {
      // Continue to next path
    }
  }

  return mapFolders;
}

function findAllModIdsFromWorkshop(workshopId, serverPath) {
  const mods = getModDetailsFromWorkshop(workshopId, serverPath);
  return mods.map((m) => m.id);
}

function findModIdFromWorkshop(workshopId, serverPath) {
  const mods = getModDetailsFromWorkshop(workshopId, serverPath);
  return mods.length > 0 ? mods[0].id : null;
}

function isModIdVerifiedOnDisk(modId, currentWorkshopIds, serverPath) {
  if (!serverPath || !currentWorkshopIds?.length) return false;
  for (const wsId of currentWorkshopIds) {
    try {
      if (findAllModIdsFromWorkshop(wsId, serverPath).includes(modId)) {
        return true;
      }
    } catch {
      // Unreadable/missing workshop folder for this ID -- not evidence
      // either way, keep checking the rest.
    }
  }
  return false;
}

function sanitizeModIdListWithDiskBypass(ids, currentWorkshopIds, serverPath) {
  const out = [];
  for (const raw of ids || []) {
    const v = sanitizeIniValue(raw);
    if (!v) continue;
    if (
      looksLikeWorkshopId(v) &&
      !isModIdVerifiedOnDisk(v, currentWorkshopIds, serverPath)
    ) {
      continue;
    }
    out.push(v);
  }
  return out.join(";");
}


function parseModInfoVersionFolder(folderName) {
  if (!/^\d+(?:\.\d+)*$/.test(folderName)) return null;
  return folderName.split(".").map((part) => Number.parseInt(part, 10));
}

function compareModInfoCandidatePaths(leftCandidate, rightCandidate) {
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

export function getModDetailsFromWorkshop(workshopId, serverPath) {
  const mods = [];
  const seenIds = new Set();
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);

  function parseModInfoFile(modInfoPath) {
    const ids = [];
    const meta = {};
    let content;
    try {
      content = readTextFile(modInfoPath);
    } catch {
      return { ids, meta };
    }
    if (!content) return { ids, meta };
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1).trim();
      if (!key) continue;
      if (key.toLowerCase() === "id") {
        if (val) ids.push(val);
      } else if (!(key in meta)) {
        meta[key] = val;
      }
    }
    return { ids, meta };
  }

  for (const workshopPath of possiblePaths) {
    if (!fs.existsSync(workshopPath)) continue;

    const modsFolder = path.join(workshopPath, "mods");
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const modDir = path.join(searchPath, entry.name);
        const candidatePaths = [
          {
            path: path.join(modDir, "mod.info"),
            version: null,
            order: 0,
          },
        ];
        try {
          const subfolders = fs
            // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
            .readdirSync(modDir, { withFileTypes: true })
            .filter((sub) => sub.isDirectory())
            .map((sub) => sub.name)
            .sort((leftName, rightName) =>
              leftName.localeCompare(rightName, undefined, {
                numeric: true,
                sensitivity: "base",
              }),
            );
          for (const [subIndex, subfolder] of subfolders.entries()) {
            candidatePaths.push({
              path: path.join(modDir, subfolder, "mod.info"),
              version: parseModInfoVersionFolder(subfolder),
              order: subIndex + 1,
            });
          }
        } catch (e) {
          log.debug(`Failed to scan subdirs for ${modDir}: ${e.message}`);
        }

        for (const candidate of candidatePaths
          // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at this file's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
          .filter((item) => fs.existsSync(item.path))
          .sort(compareModInfoCandidatePaths)) {
          const { ids, meta } = parseModInfoFile(candidate.path);
          for (const id of ids) {
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            mods.push({
              id,
              name: meta.name || id,
              poster: meta.poster,
              icon: meta.icon,
              description: meta.description || "",
              url: meta.url,
              require: meta.require
                ? meta.require
                    .split(/[,;]/)
                    .map((s) => s.trim().replace(/^\\+/, ""))
                    .filter(Boolean)
                : [],
            });
          }
        }
      }

      if (mods.length > 0) return mods;
    } catch (e) {
      log.debug(`Error scanning path ${searchPath}: ${e.message}`);
    }
  }

  return mods;
}

export function scoreWorkshopDependencyMatch(query, modId, modName) {
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[\s_.\-+\[\]()]/g, "");
  const queryLower = String(query || "")
    .toLowerCase()
    .trim();
  const idLower = String(modId || "").toLowerCase();
  const nameLower = String(modName || "").toLowerCase();
  const queryNormalized = normalize(query);
  const idNormalized = normalize(modId);
  const nameNormalized = normalize(modName);

  if (!queryLower || !idLower) return { score: 0, matchType: "none" };
  if (idLower === queryLower) return { score: 1200, matchType: "exact-id" };
  if (idNormalized === queryNormalized)
    return { score: 1100, matchType: "exact-id" };
  if (nameLower === queryLower || nameNormalized === queryNormalized)
    return { score: 950, matchType: "exact-name" };
  if (
    idLower.startsWith(queryLower) ||
    idNormalized.startsWith(queryNormalized)
  )
    return { score: 650, matchType: "id-prefix" };
  if (
    nameLower.startsWith(queryLower) ||
    nameNormalized.startsWith(queryNormalized)
  )
    return { score: 550, matchType: "name-prefix" };
  if (idLower.includes(queryLower) || idNormalized.includes(queryNormalized))
    return { score: 350, matchType: "id-contains" };
  if (
    nameLower.includes(queryLower) ||
    nameNormalized.includes(queryNormalized)
  )
    return { score: 250, matchType: "name-contains" };
  return { score: 0, matchType: "none" };
}

router.post("/inspect-workshop-item", async (req, res) => {
  try {
    const { workshopId } = req.body;
    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const serverPath = await getServerPath();
    if (!serverPath) {
      return res.status(400).json({
        error: "Server path not configured",
        code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED_NOPERIOD,
      });
    }

    const mods = getModDetailsFromWorkshop(workshopId, serverPath);

    const mapFolders = findMapFoldersFromWorkshop(workshopId, serverPath);

    res.json({
      workshopId,
      found: mods.length > 0 || mapFolders.length > 0,
      mods,
      mapFolders,
      count: mods.length,
    });
  } catch (error) {
    log.error(`Failed to inspect workshop item: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/remove-from-ini", async (req, res) => {
  try {
    const { workshopId, modId, modIds: clientModIds } = req.body;

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const knownModIds = Array.isArray(clientModIds)
      ? clientModIds.slice(0, 50)
      : [];

    const serverConfigPath = await getServerConfigPath();
    const serverPath = await getServerPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      let workshopIds = workshopMatch?.[1]?.split(";").filter(Boolean) || [];

      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      let modIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];

      workshopIds = workshopIds.filter((id) => id !== String(workshopId));

      let removedModIds = [];
      let ownedModIds = [];

      if (serverPath) {
        const allModIds = findAllModIdsFromWorkshop(
          String(workshopId),
          serverPath,
        );
        ownedModIds = allModIds;
        if (allModIds.length > 0) {
          for (const mid of allModIds) {
            if (modIds.includes(mid)) {
              modIds = modIds.filter((id) => id !== mid);
              removedModIds.push(mid);
            }
          }
          log.info(
            `Found mod IDs for workshop ${workshopId}: ${allModIds.join(", ")}`,
          );
        }
      }

      if (
        modId &&
        ownedModIds.includes(modId) &&
        !removedModIds.includes(modId) &&
        modIds.includes(modId)
      ) {
        modIds = modIds.filter((id) => id !== modId);
        removedModIds.push(modId);
      }

      if (removedModIds.length === 0 && !modId && serverPath) {
        const fallbackModId = findModIdFromWorkshop(
          String(workshopId),
          serverPath,
        );
        if (fallbackModId && modIds.includes(fallbackModId)) {
          modIds = modIds.filter((id) => id !== fallbackModId);
          removedModIds.push(fallbackModId);
        }
      }

      const verifiedKnownModIds = filterOwnedClientModIds(
        knownModIds,
        ownedModIds,
      );
      if (removedModIds.length === 0 && verifiedKnownModIds.length > 0) {
        for (const mid of verifiedKnownModIds) {
          if (modIds.includes(mid) && !removedModIds.includes(mid)) {
            modIds = modIds.filter((id) => id !== mid);
            removedModIds.push(mid);
          }
        }
        if (removedModIds.length > 0) {
          log.info(
            `Fallback: removed ${removedModIds.join(", ")} for workshop ${workshopId} via client-provided mod IDs`,
          );
        }
      }

      let removedMapFolders = [];
      if (serverPath) {
        const modMapFolders = findMapFoldersFromWorkshop(
          String(workshopId),
          serverPath,
        );
        if (modMapFolders.length > 0) {
          const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
          let currentMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [];

          for (const folder of modMapFolders) {
            if (currentMaps.includes(folder)) {
              currentMaps = currentMaps.filter((m) => m !== folder);
              removedMapFolders.push(folder);
              log.info(
                `Removed map folder: ${folder} for workshop ${workshopId}`,
              );
            }
          }

          if (currentMaps.length === 0) {
            currentMaps = ["Muldraugh, KY"];
          }

          const newMapList = currentMaps.join(";");
          if (mapMatch) {
            content = content.replace(/^[ \t]*Map[ \t]*=.*/m, `Map=${newMapList}`);
          } else {
            content += `\nMap=${newMapList}`;
          }
        }
      }

      if (workshopMatch) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          `WorkshopItems=${sanitizeIniList(workshopIds)}`,
        );
      }

      if (modsMatch) {
        content = content.replace(
          /^[ \t]*Mods[ \t]*=.*/m,
          `Mods=${sanitizeModIdList(modIds)}`,
        );
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return {
        removedModIds,
        removedMapFolders,
        remainingWorkshopItems: workshopIds.length,
        remainingMods: modIds.length,
        backupWarning,
      };
    });

    log.info(
      `Removed workshop ID ${workshopId}${lockResult.removedModIds.length > 0 ? ` and mod IDs ${lockResult.removedModIds.join(", ")}` : ""}${lockResult.removedMapFolders.length > 0 ? ` and map folders: ${lockResult.removedMapFolders.join(", ")}` : ""} from ${iniPath}`,
    );

    res.json({
      success: true,
      message:
        lockResult.removedModIds.length > 0
          ? `Mod removed from server configuration (WorkshopItems, Mods${lockResult.removedMapFolders.length > 0 ? ", and Map" : ""})`
          : "Workshop ID removed. Note: Could not find matching mod ID - you may need to manually remove it from Mods= in the .ini file.",
      workshopId,
      modIdsRemoved: lockResult.removedModIds,
      mapFoldersRemoved: lockResult.removedMapFolders,
      remainingWorkshopItems: lockResult.remainingWorkshopItems,
      remainingMods: lockResult.remainingMods,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to remove mod from ini: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/batch-remove", async (req, res) => {
  try {
    const { workshopIds } = req.body;

    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res.status(400).json({
        error: "workshopIds array is required",
        code: ErrorCode.MODS_BATCH_REMOVE_WORKSHOP_IDS_ARRAY_REQUIRED,
      });
    }

    if (workshopIds.length > 500) {
      return res.status(400).json({
        error: "Maximum 500 mods per batch",
        code: ErrorCode.MODS_BATCH_REMOVE_TOO_MANY,
      });
    }

    const validIds = [];
    for (const id of workshopIds) {
      const str = String(id);
      if (/^\d{1,15}$/.test(str)) validIds.push(str);
    }

    if (validIds.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }

    const trackedMods = await getTrackedMods();
    const modNameMap = new Map();
    for (const mod of trackedMods) {
      modNameMap.set(mod.workshop_id, mod.name);
    }

    const dbResults = { removed: 0, failed: 0 };

    const serverConfigPath = await getServerConfigPath();
    const serverPath = await getServerPath();
    const serverName = await getServerName();

    let iniResult = { removed: 0, skipped: 0 };
    let iniEditApplied = false;

    if (serverConfigPath && serverName) {
      const sanitizedServerName = path.basename(serverName);
      if (
        sanitizedServerName &&
        sanitizedServerName === serverName &&
        !serverName.includes("..")
      ) {
        const iniPath = path.join(
          serverConfigPath,
          `${sanitizedServerName}.ini`,
        );

        if (fs.existsSync(iniPath)) {
          iniEditApplied = true;
          iniResult = await withIniLock(iniPath, async () => {
            let content = readTextFile(iniPath);
            const removeSet = new Set(validIds);

            const workshopMatch = content.match(
              /^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m,
            );
            let iniWorkshopIds =
              workshopMatch?.[1]?.split(";").filter(Boolean) || [];

            const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
            let iniModIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];

            const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
            let iniMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [];

            const modIdsToRemove = new Set();
            const mapFoldersToRemove = new Set();

            for (const wsId of validIds) {
              if (serverPath) {
                const allModIds = findAllModIdsFromWorkshop(wsId, serverPath);
                for (const mid of allModIds) modIdsToRemove.add(mid);

                const mapFolders = findMapFoldersFromWorkshop(wsId, serverPath);
                for (const folder of mapFolders) mapFoldersToRemove.add(folder);
              }
            }

            const origWsCount = iniWorkshopIds.length;
            const origModCount = iniModIds.length;
            iniWorkshopIds = iniWorkshopIds.filter((id) => !removeSet.has(id));
            iniModIds = iniModIds.filter((id) => !modIdsToRemove.has(id));
            iniMaps = iniMaps.filter((m) => !mapFoldersToRemove.has(m));

            if (iniMaps.length === 0) iniMaps = ["Muldraugh, KY"];

            if (workshopMatch) {
              content = content.replace(
                /^[ \t]*WorkshopItems[ \t]*=.*/m,
                `WorkshopItems=${sanitizeIniList(iniWorkshopIds)}`,
              );
            }
            if (modsMatch) {
              content = content.replace(
                /^[ \t]*Mods[ \t]*=.*/m,
                `Mods=${sanitizeModIdList(iniModIds)}`,
              );
            }
            if (mapMatch) {
              content = content.replace(
                /^[ \t]*Map[ \t]*=.*/m,
                `Map=${sanitizeIniList(iniMaps)}`,
              );
            }

            const backupWarning = backupWarningFor(
              await writeIniWithBackup(iniPath, content),
            );

            const wsRemoved = origWsCount - iniWorkshopIds.length;
            const modRemoved = origModCount - iniModIds.length;
            log.info(
              `Batch INI removal: removed ${wsRemoved} workshop IDs, ${modRemoved} mod IDs, ${mapFoldersToRemove.size} map folders`,
            );

            return {
              removed: wsRemoved,
              skipped: validIds.length - wsRemoved,
              backupWarning,
            };
          });
        }
      }
    }

    if (iniEditApplied) {
      for (const wsId of validIds) {
        try {
          await removeTrackedMod(wsId);
          await addIgnoredMod(wsId, modNameMap.get(wsId) || null);
          dbResults.removed++;
        } catch (e) {
          dbResults.failed++;
          log.debug(`DB removal failed for ${wsId}: ${e.message}`);
        }
      }
    } else {
      log.error(
        `Batch removal aborted before any INI edit (serverConfigPath=${serverConfigPath}, serverName=${serverName}, validIds=${validIds.join(",")}) — nothing was removed or ignore-listed`,
      );
    }

    if (iniEditApplied && validIds.length > 0) {
      (async () => {
        for (const wsId of validIds) {
          try {
            await autoSyncCollection("remove", wsId);
          } catch {
            /* logged inside */
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      })().catch(() => {});
    }

    res.json({
      success: iniEditApplied,
      total: validIds.length,
      dbRemoved: dbResults.removed,
      dbFailed: dbResults.failed,
      iniRemoved: iniResult.removed,
      iniSkipped: iniResult.skipped,
      ...(iniResult.backupWarning ? { backupWarning: iniResult.backupWarning } : {}),
      ...(iniEditApplied
        ? {}
        : {
            error:
              "Server config file was not found or not accessible — no mods were removed.",
            code: ErrorCode.MODS_BATCH_REMOVE_INI_NOT_ACCESSIBLE,
          }),
    });
  } catch (error) {
    log.error(`Batch removal failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/repair-map-entries", async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverPath = await getServerPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverPath || !serverName) {
      return res.status(400).json({
        error: "Server path not configured.",
        code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_PERIOD,
      });
    }

    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
      const currentMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [];

      const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const workshopIds = workshopMatch?.[1]?.split(";").filter(Boolean) || [];

      const validMapFolders = new Set();
      for (const wsId of workshopIds) {
        const folders = findMapFoldersFromWorkshop(wsId, serverPath);
        for (const f of folders) validMapFolders.add(f);
      }
      validMapFolders.add("Muldraugh, KY");

      const validEntries = [];
      const removedEntries = [];
      for (const entry of currentMaps) {
        if (
          validMapFolders.has(entry) ||
          entry.includes("Muldraugh") ||
          entry.includes("West Point") ||
          entry.includes("Riverside") ||
          entry.includes("Rosewood") ||
          entry.includes("March Ridge") ||
          entry.includes("Louisville")
        ) {
          validEntries.push(entry);
        } else {
          removedEntries.push(entry);
        }
      }

      const addedEntries = [];
      for (const folder of validMapFolders) {
        if (folder === "Muldraugh, KY") continue;
        if (!validEntries.includes(folder)) {
          const mulIdx = validEntries.findIndex((e) => e.includes("Muldraugh"));
          if (mulIdx >= 0) {
            validEntries.splice(mulIdx, 0, folder);
          } else {
            validEntries.push(folder);
          }
          addedEntries.push(folder);
        }
      }

      if (!validEntries.some((e) => e.includes("Muldraugh"))) {
        validEntries.push("Muldraugh, KY");
      }

      let backupWarning = null;
      if (removedEntries.length > 0 || addedEntries.length > 0) {
        const newMapLine = validEntries.join(";");
        if (mapMatch) {
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, `Map=${newMapLine}`);
        }
        backupWarning = backupWarningFor(
          await writeIniWithBackup(iniPath, content),
        );
        log.info(
          `Repaired Map= entries: removed ${removedEntries.length} invalid, added ${addedEntries.length} missing`,
        );
        if (removedEntries.length > 0)
          log.info(`  Removed: ${removedEntries.join(", ")}`);
        if (addedEntries.length > 0)
          log.info(`  Added: ${addedEntries.join(", ")}`);
      }

      return { removedEntries, addedEntries, validEntries, backupWarning };
    });

    const parts = [];
    if (lockResult.removedEntries.length > 0)
      parts.push(
        `Removed ${lockResult.removedEntries.length} invalid: ${lockResult.removedEntries.join(", ")}`,
      );
    if (lockResult.addedEntries.length > 0)
      parts.push(
        `Added ${lockResult.addedEntries.length} missing: ${lockResult.addedEntries.join(", ")}`,
      );

    res.json({
      success: true,
      removed: lockResult.removedEntries,
      added: lockResult.addedEntries,
      remaining: lockResult.validEntries,
      message:
        parts.length > 0
          ? parts.join(". ")
          : "All map entries are valid. No changes needed.",
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to repair map entries: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/deduplicate-mod-ids", async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server path not configured.",
        code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found.",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND_PERIOD,
      });
    }

    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentMods = modsMatch?.[1]?.split(";").filter(Boolean) || [];

      const seen = new Map();
      const deduped = [];
      const removed = [];
      for (const modId of currentMods) {
        const count = (seen.get(modId) || 0) + 1;
        seen.set(modId, count);
        if (count === 1) {
          deduped.push(modId);
        } else {
          removed.push(modId);
        }
      }

      if (removed.length === 0) {
        return { noChanges: true, deduped };
      }

      content = content.replace(
        /^[ \t]*Mods[ \t]*=.*/m,
        `Mods=${sanitizeModIdList(deduped)}`,
      );
      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { noChanges: false, removed, deduped, backupWarning };
    });

    if (lockResult.noChanges) {
      return res.json({
        success: true,
        removed: [],
        remaining: lockResult.deduped.length,
        message: "No duplicate mod IDs found. No changes needed.",
      });
    }

    const uniqueDupes = [...new Set(lockResult.removed)];
    log.info(
      `Deduplicated Mods= line: removed ${lockResult.removed.length} duplicate entries (${uniqueDupes.length} unique mod IDs: ${uniqueDupes.join(", ")})`,
    );

    res.json({
      success: true,
      removed: uniqueDupes,
      removedCount: lockResult.removed.length,
      uniqueCount: uniqueDupes.length,
      remaining: lockResult.deduped.length,
      message: `Removed ${lockResult.removed.length} duplicate mod ID${lockResult.removed.length !== 1 ? "s" : ""}: ${uniqueDupes.join(", ")}`,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to deduplicate mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/add-missing-dep", async (req, res) => {
  try {
    const { workshopId, modId } = req.body;
    if (!workshopId || !/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Valid Workshop ID is required",
        code: ErrorCode.MODS_ADD_MISSING_DEP_WORKSHOP_ID_REQUIRED,
      });
    }
    const modIdStr = modId ? String(modId) : null;
    if (modIdStr && !/^[\w.\-]{1,200}$/.test(modIdStr)) {
      return res.status(400).json({
        error: "Invalid mod ID format",
        code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    if (!serverConfigPath || !serverName)
      return res.status(400).json({
        error: "Server path not configured.",
        code: ErrorCode.MODS_SERVER_PATH_NOT_CONFIGURED,
      });

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const wsIdStr = String(workshopId);
    let resolvedModId = modIdStr;
    if (!resolvedModId && serverPath) {
      resolvedModId = findModIdFromWorkshop(wsIdStr, serverPath);
    }
    if (!resolvedModId) {
      resolvedModId = await fetchModIdFromWorkshop(wsIdStr);
    }

    const mapFolders = serverPath
      ? findMapFoldersFromWorkshop(wsIdStr, serverPath)
      : [];

    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const currentWs = wsMatch?.[1]?.split(";").filter(Boolean) || [];
      let wsAdded = false;
      if (!currentWs.includes(wsIdStr)) {
        currentWs.push(wsIdStr);
        const wsLine = `WorkshopItems=${sanitizeIniList(currentWs)}`;
        if (wsMatch) {
          content = content.replace(/^[ \t]*WorkshopItems[ \t]*=.*/m, wsLine);
        } else {
          content += `\n${wsLine}`;
        }
        wsAdded = true;
      }

      let modIdAdded = false;
      if (resolvedModId) {
        const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
        const currentMods = modsMatch?.[1]?.split(";").filter(Boolean) || [];
        if (!currentMods.includes(resolvedModId)) {
          currentMods.push(resolvedModId);
          if (modsMatch) {
            content = content.replace(
              /^[ \t]*Mods[ \t]*=.*/m,
              `Mods=${sanitizeModIdList(currentMods)}`,
            );
          } else {
            content += `\nMods=${sanitizeModIdList(currentMods)}`;
          }
          modIdAdded = true;
        }
      }

      if (mapFolders.length > 0) {
        const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
        const currentMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [];
        let mapsChanged = false;
        for (const f of mapFolders) {
          if (!currentMaps.includes(f)) {
            currentMaps.unshift(f);
            mapsChanged = true;
          }
        }
        if (mapsChanged) {
          if (mapMatch)
            content = content.replace(
              /^[ \t]*Map[ \t]*=.*/m,
              `Map=${currentMaps.join(";")}`,
            );
          else content += `\nMap=${currentMaps.join(";")}`;
        }
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { wsAdded, modIdAdded, backupWarning };
    });

    log.info(
      `Added missing dep: workshop ${wsIdStr}, modId ${resolvedModId || "(unknown)"}`,
    );

    res.json({
      success: true,
      workshopId: wsIdStr,
      modId: resolvedModId,
      wsAdded: lockResult.wsAdded,
      modIdAdded: lockResult.modIdAdded,
      mapFolders,
      message: `Added ${resolvedModId || wsIdStr} to server config.${mapFolders.length > 0 ? ` Map folders: ${mapFolders.join(", ")}` : ""}`,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to add missing dep: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/add-all-resolved-deps", async (req, res) => {
  try {
    const { deps } = req.body;
    if (!deps || !Array.isArray(deps) || deps.length === 0) {
      return res.status(400).json({
        error: "No dependencies provided",
        code: ErrorCode.MODS_ADD_ALL_DEPS_REQUIRED,
      });
    }
    if (deps.length > 200) {
      return res.status(400).json({
        error: "Too many dependencies in one request (max 200)",
        code: ErrorCode.MODS_ADD_ALL_DEPS_TOO_MANY,
      });
    }

    for (const dep of deps) {
      if (!dep.workshopId || !/^\d{1,15}$/.test(String(dep.workshopId))) {
        const workshopId = String(dep.workshopId).substring(0, 20);
        return res.status(400).json({
          error: `Invalid Workshop ID: ${workshopId}`,
          code: ErrorCode.MODS_INVALID_WORKSHOP_ID_TEMPLATE,
          params: sanitizeErrorParams({ workshopId }),
        });
      }
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const resolvedDeps = [];
    for (const dep of deps) {
      const wsId = String(dep.workshopId);
      let modId = dep.modId || null;
      if (!modId && serverPath) modId = findModIdFromWorkshop(wsId, serverPath);
      if (!modId) {
        try {
          modId = await fetchModIdFromWorkshop(wsId);
        } catch (e) {
          log.debug(`fetchModIdFromWorkshop failed for ${wsId}: ${e.message}`);
        }
      }
      const mapFolders = serverPath
        ? findMapFoldersFromWorkshop(wsId, serverPath)
        : [];
      resolvedDeps.push({ wsId, modId, mapFolders });
    }

    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const currentWs = new Set(wsMatch?.[1]?.split(";").filter(Boolean) || []);
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentMods = new Set(
        modsMatch?.[1]?.split(";").filter(Boolean) || [],
      );
      const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
      const currentMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [];

      let wsAdded = 0,
        modIdsAdded = 0;
      const allMapFolders = [];
      const itemResults = [];

      for (const { wsId, modId, mapFolders } of resolvedDeps) {
        let itemWsAdded = false;
        let itemModIdAdded = false;
        if (!currentWs.has(wsId)) {
          currentWs.add(wsId);
          wsAdded++;
          itemWsAdded = true;
        }
        if (modId && !currentMods.has(modId)) {
          currentMods.add(modId);
          modIdsAdded++;
          itemModIdAdded = true;
        }
        itemResults.push({
          workshopId: wsId,
          modId,
          wsAdded: itemWsAdded,
          modIdAdded: itemModIdAdded,
        });
        for (const f of mapFolders) {
          if (!currentMaps.includes(f)) {
            currentMaps.unshift(f);
            allMapFolders.push(f);
          }
        }
      }

      const wsLine = Array.from(currentWs).join(";");
      const modsLine = sanitizeModIdList(Array.from(currentMods));
      const mapLine = currentMaps.join(";");

      if (wsMatch)
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          `WorkshopItems=${wsLine}`,
        );
      else content += `\nWorkshopItems=${wsLine}`;
      if (modsMatch)
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${modsLine}`);
      else content += `\nMods=${modsLine}`;
      if (allMapFolders.length > 0) {
        if (mapMatch)
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, `Map=${mapLine}`);
        else content += `\nMap=${mapLine}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return { wsAdded, modIdsAdded, allMapFolders, backupWarning, itemResults };
    });

    const unresolvedCount = lockResult.itemResults.filter((r) => r.modId === null).length;
    log.info(
      `Batch added ${deps.length} missing deps: ${lockResult.wsAdded} ws IDs, ${lockResult.modIdsAdded} mod IDs` +
        (unresolvedCount > 0 ? `, ${unresolvedCount} mod ID(s) unresolved` : ""),
    );

    res.json({
      success: true,
      total: deps.length,
      wsAdded: lockResult.wsAdded,
      modIdsAdded: lockResult.modIdsAdded,
      mapFolders: lockResult.allMapFolders,
      results: lockResult.itemResults,
      message: `Added ${deps.length} dependencies to server config.`,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to batch add deps: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/search-workshop-mods", async (req, res) => {
  try {
    const { query, parentName, parentWorkshopId, parentModId } = req.body;
    if (!query || typeof query !== "string" || query.trim().length < 2) {
      return res
        .status(400)
        .json({
          error: "Query must be at least 2 characters",
          code: ErrorCode.MODS_SEARCH_QUERY_TOO_SHORT,
        });
    }

    const trimmed = query.trim();
    if (trimmed.length > 100) {
      log.debug(`Search query truncated from ${trimmed.length} to 100 chars`);
    }
    const searchTerm = trimmed.substring(0, 100);
    const parentNameClean =
      typeof parentName === "string" ? parentName.trim().substring(0, 100) : "";
    const parentWsClean =
      typeof parentWorkshopId === "string" &&
      /^\d{1,15}$/.test(parentWorkshopId)
        ? parentWorkshopId
        : "";
    const parentModClean =
      typeof parentModId === "string" && parentModId.length < 100
        ? parentModId
        : "";
    const serverPath = await getServerPath();

    const buildSearchVariants = (raw, parent) => {
      const variants = [];
      const seen = new Set();
      const push = (v) => {
        if (!v) return;
        const s = v.trim().toLowerCase();
        if (s.length < 3 || seen.has(s)) return;
        seen.add(s);
        variants.push(v.trim());
      };
      const stripSuffixes = (s) =>
        s
          .replace(
            /[_-]?(b4[12]fix|b4[12]_fix|b4[12]|fix(es)?|patch|patches|update|updates|v\d+(\.\d+)*|rev\d+|reupload|continued|continuation|port|ported|edition)$/gi,
            "",
          )
          .trim();
      const humanize = (s) =>
        s
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .replace(/[_\-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      push(raw);
      const humanized = humanize(raw);
      if (humanized.toLowerCase() !== raw.toLowerCase()) push(humanized);
      const stripped = stripSuffixes(raw);
      if (stripped.toLowerCase() !== raw.toLowerCase()) push(stripped);
      const humanizedStripped = humanize(stripped);
      if (
        humanizedStripped.toLowerCase() !== humanized.toLowerCase() &&
        humanizedStripped.toLowerCase() !== stripped.toLowerCase()
      )
        push(humanizedStripped);
      if (parent) {
        push(parent);
        const parentStripped = stripSuffixes(parent);
        if (parentStripped.toLowerCase() !== parent.toLowerCase())
          push(parentStripped);
      }
      return variants;
    };
    const searchVariants = buildSearchVariants(searchTerm, parentNameClean);

    const localResults = [];
    const seenWorkshopIds = new Set();
    let hasExactLocalMatch = false;
    if (serverPath) {
      const workshopPaths = [
        path.join(serverPath, "steamapps", "workshop", "content", "108600"),
        path.join(
          serverPath,
          "..",
          "steamapps",
          "workshop",
          "content",
          "108600",
        ),
      ];
      for (const workshopBase of workshopPaths) {
        if (!fs.existsSync(workshopBase)) continue;
        try {
          for (const entry of fs.readdirSync(workshopBase, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            if (localResults.length >= 20) break;
            if (parentWsClean && entry.name === parentWsClean) continue;
            try {
              const details = getModDetailsFromWorkshop(entry.name, serverPath);
              for (const mod of details) {
                if (parentModClean && mod.id === parentModClean) continue;
                const scored = scoreWorkshopDependencyMatch(
                  searchTerm,
                  mod.id,
                  mod.name,
                );
                if (scored.score > 0) {
                  if (!seenWorkshopIds.has(`${entry.name}-${mod.id}`)) {
                    seenWorkshopIds.add(`${entry.name}-${mod.id}`);
                    localResults.push({
                      workshopId: entry.name,
                      modId: mod.id,
                      modName: mod.name,
                      source: "local",
                      isDownloaded: true,
                      exactMatch: scored.matchType === "exact-id",
                      matchType: scored.matchType,
                      relevance: scored.score,
                    });
                  }
                }
              }
            } catch (e) {
              log.debug(`Error scanning mod entry during search: ${e.message}`);
            }
          }
        } catch (e) {
          log.debug(`Error reading workshop dir during search: ${e.message}`);
        }
        if (localResults.length >= 20) break;
      }
      const exactLocalMatches = localResults.filter(
        (result) => result.matchType === "exact-id",
      );
      if (exactLocalMatches.length > 0) {
        hasExactLocalMatch = true;
        localResults.splice(0, localResults.length, ...exactLocalMatches);
      }

      localResults.sort((a, b) => {
        if ((b.relevance || 0) !== (a.relevance || 0))
          return (b.relevance || 0) - (a.relevance || 0);
        return a.modName.localeCompare(b.modName);
      });
    }

    const steamResults = [];
    if (/^\d{5,15}$/.test(searchTerm)) {
      const alreadyFoundLocally = localResults.some(
        (r) => r.workshopId === searchTerm,
      );
      if (!alreadyFoundLocally) {
        try {
          const response = await fetch(
            "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                itemcount: "1",
                "publishedfileids[0]": searchTerm,
              }),
            },
          );
          if (response.ok) {
            const data = await response.json();
            const info = data.response?.publishedfiledetails?.[0];
            if (info && info.result === 1) {
              steamResults.push({
                workshopId: info.publishedfileid,
                modName: info.title,
                description: info.description?.substring(0, 200),
                subscriberCount: info.subscriptions || 0,
                source: "steam",
                isDownloaded: false,
              });
            }
          }
        } catch (e) {
          log.debug(`Steam collection lookup failed (non-fatal): ${e.message}`);
        }
      }
    }

    let steamSearchEnabled = false;
    let steamSearchAttempted = false;
    if (!/^\d{5,15}$/.test(searchTerm) && !hasExactLocalMatch) {
      try {
        const steamApiKey = await getSteamApiKey();
        if (
          steamApiKey &&
          typeof steamApiKey === "string" &&
          steamApiKey.length > 10
        ) {
          steamSearchEnabled = true;
          const lowerOriginal = searchTerm.toLowerCase();
          const scoreCandidate = (title) => {
            const t = (title || "").toLowerCase();
            if (!t) return 0;
            if (t === lowerOriginal) return 1000;
            if (t.replace(/[\s_-]/g, "") === lowerOriginal) return 900;
            if (t.startsWith(lowerOriginal)) return 700;
            if (t.includes(lowerOriginal)) return 500;
            const queryTokens = lowerOriginal
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .split(/[\s_-]+/)
              .filter((x) => x.length > 2);
            if (queryTokens.length === 0) return 0;
            const matched = queryTokens.filter((tok) => t.includes(tok)).length;
            return Math.round((matched / queryTokens.length) * 400);
          };

          const seenSteamIds = new Set([
            ...localResults.map((r) => r.workshopId),
            ...steamResults.map((r) => r.workshopId),
          ]);
          if (parentWsClean) seenSteamIds.add(parentWsClean);
          const collected = [];
          const targetCount = 12;

          for (const variant of searchVariants) {
            if (collected.length >= targetCount) break;
            steamSearchAttempted = true;
            const params = new URLSearchParams({
              key: steamApiKey,
              query_type: "12", // k_PublishedFileQueryType_RankedByTextSearch
              page: "1",
              numperpage: "15",
              appid: "108600", // Project Zomboid
              search_text: variant,
              return_short_description: "true",
              return_metadata: "true",
            });
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 8000);
              const response = await fetch(
                `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params}`,
                {
                  signal: controller.signal,
                },
              );
              clearTimeout(timeout);
              if (!response.ok) continue;
              const data = await response.json();
              const files = data.response?.publishedfiledetails || [];
              for (const item of files) {
                if (!item.publishedfileid || item.result !== 1) continue;
                const wsId = String(item.publishedfileid);
                if (seenSteamIds.has(wsId)) continue;
                seenSteamIds.add(wsId);
                const title = item.title || `Workshop ${wsId}`;
                const desc = item.short_description?.substring(0, 200) || "";
                const score =
                  scoreCandidate(title) +
                  Math.min(50, Math.log10((item.subscriptions || 0) + 1) * 10);
                collected.push({
                  workshopId: wsId,
                  modName: title,
                  description: desc,
                  subscriberCount: item.subscriptions || 0,
                  score,
                  matchedVariant: variant,
                });
              }
            } catch (e) {
              log.debug?.(
                `Steam text search variant "${variant}" failed (non-fatal): ${e.message}`,
              );
            }
          }

          collected.sort((a, b) => b.score - a.score);
          for (const c of collected.slice(0, targetCount)) {
            steamResults.push({
              workshopId: c.workshopId,
              modName: c.modName,
              description: c.description,
              subscriberCount: c.subscriberCount,
              source: "steam",
              isDownloaded: false,
              matchedVariant: c.matchedVariant,
              relevance: c.score,
            });
          }
        }
      } catch (e) {
        log.debug?.(`Steam text search failed (non-fatal): ${e.message}`);
      }
    }

    res.json({
      success: true,
      query: searchTerm,
      variantsTried: searchVariants,
      steamSearchEnabled,
      steamSearchAttempted,
      results: [...localResults, ...steamResults],
      searchUrl: `https://steamcommunity.com/workshop/browse/?appid=108600&searchtext=${encodeURIComponent(searchTerm)}`,
    });
  } catch (error) {
    log.error(`Workshop search failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/resolve-missing-deps", async (req, res) => {
  try {
    const { deps } = req.body;
    if (!deps || !Array.isArray(deps)) {
      return res.status(400).json({
        error: "Dependencies array is required",
        code: ErrorCode.MODS_RESOLVE_DEPS_ARRAY_REQUIRED,
      });
    }

    const serverPath = await getServerPath();
    const resolved = [];

    for (const dep of deps) {
      const missingDep = dep.missingDep;
      if (!missingDep || typeof missingDep !== "string") continue;
      if (dep.resolvedWorkshopId) {
        resolved.push(dep);
        continue;
      }

      let found = false;
      if (serverPath) {
        const workshopPaths = [
          path.join(serverPath, "steamapps", "workshop", "content", "108600"),
          path.join(
            serverPath,
            "..",
            "steamapps",
            "workshop",
            "content",
            "108600",
          ),
        ];
        for (const workshopBase of workshopPaths) {
          if (found || !fs.existsSync(workshopBase)) continue;
          try {
            for (const entry of fs.readdirSync(workshopBase, {
              withFileTypes: true,
            })) {
              if (!entry.isDirectory() || found) continue;
              try {
                const details = getModDetailsFromWorkshop(
                  entry.name,
                  serverPath,
                );
                for (const mod of details) {
                  if (mod.id === missingDep) {
                    resolved.push({
                      ...dep,
                      resolvedWorkshopId: entry.name,
                      resolvedModName: mod.name,
                    });
                    found = true;
                    break;
                  }
                }
              } catch (e) {
                log.debug(
                  `Error reading mod details during dep resolution: ${e.message}`,
                );
              }
            }
          } catch (e) {
            log.debug(
              `Error reading workshop path during dep scan: ${e.message}`,
            );
          }
        }
      }
      if (!found) resolved.push(dep);
    }

    res.json({
      success: true,
      deps: resolved,
      resolvedCount: resolved.filter((d) => d.resolvedWorkshopId).length,
    });
  } catch (error) {
    log.error(`Failed to resolve missing deps: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sync-mod-ids", async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }
    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const preContent = readTextFile(iniPath);
    const preWorkshopMatch = preContent.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const workshopIds = (
      preWorkshopMatch?.[1]?.split(";").filter(Boolean) || []
    ).filter((id) => /^\d{1,15}$/.test(id));

    const resolvedMap = new Map();
    for (const workshopId of workshopIds) {
      try {
        const availableModIds = findAllModIdsFromWorkshop(
          workshopId,
          serverPath,
        );
        if (availableModIds.length > 0) {
          resolvedMap.set(workshopId, { availableModIds, fallbackId: null });
        } else {
          const fallbackId = await fetchModIdFromWorkshop(workshopId);
          resolvedMap.set(workshopId, { availableModIds: [], fallbackId });
        }
      } catch (err) {
        log.error(`Error processing workshop ID ${workshopId}: ${err.message}`);
        resolvedMap.set(workshopId, {
          availableModIds: [],
          fallbackId: null,
          error: true,
        });
      }
    }

    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentModIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];
      const finalModIds = [...currentModIds];

      const syncedMods = [];
      const missingMods = [];

      for (const workshopId of workshopIds) {
        const resolved = resolvedMap.get(workshopId);
        if (!resolved || resolved.error) {
          missingMods.push(workshopId);
          continue;
        }

        const { availableModIds, fallbackId } = resolved;

        if (availableModIds.length > 0) {
          const present = availableModIds.filter((id) =>
            currentModIds.includes(id),
          );
          if (present.length > 0) {
            syncedMods.push({
              workshopId,
              mods: present,
              status: "verified_present",
            });
          } else {
            const defaultMod = availableModIds[0];
            if (!finalModIds.includes(defaultMod)) {
              finalModIds.push(defaultMod);
              syncedMods.push({
                workshopId,
                mods: [defaultMod],
                status: "added_default",
              });
              log.info(
                `Auto-added default mod ID '${defaultMod}' for workshop item ${workshopId}`,
              );
            }
            if (availableModIds.length > 1) {
              syncedMods[syncedMods.length - 1].alternatives =
                availableModIds.slice(1);
            }
          }
        } else if (fallbackId) {
          if (!finalModIds.includes(fallbackId)) {
            finalModIds.push(fallbackId);
            syncedMods.push({
              workshopId,
              mods: [fallbackId],
              status: "added_from_steam_api",
            });
          } else {
            syncedMods.push({
              workshopId,
              mods: [fallbackId],
              status: "verified_present_api",
            });
          }
        } else {
          missingMods.push(workshopId);
        }
      }

      const newModList = sanitizeModIdList(finalModIds);
      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return {
        syncedMods,
        missingMods,
        totalModIds: finalModIds.length,
        backupWarning,
      };
    });

    const addedCount = lockResult.syncedMods.filter((m) =>
      m.status.startsWith("added"),
    ).length;

    log.info(
      `Synced mod IDs: ${addedCount} added, ${lockResult.missingMods.length} missing downloads`,
    );

    res.json({
      success: true,
      message: `Synced configuration. Added ${addedCount} missing mod IDs. ${lockResult.missingMods.length} items need download.`,
      syncedMods: lockResult.syncedMods,
      missingMods: lockResult.missingMods,
      totalModIds: lockResult.totalModIds,
      note:
        lockResult.missingMods.length > 0
          ? "Start server to download missing workshop items."
          : undefined,
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to sync mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/validate-config", async (req, res) => {
  try {
    const serverConfigPath = await getServerConfigPath();
    const serverPath = await getServerPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    const content = readTextFile(iniPath);
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);

    const workshopIds = workshopMatch
      ? workshopMatch[1].split(";").filter(Boolean)
      : [];
    const modIds = modsMatch ? modsMatch[1].split(";").filter(Boolean) : [];

    const warnings = [];
    const errors = [];

    for (const { key, count } of findDuplicateIniKeys(content)) {
      errors.push({
        type: "duplicate_key",
        key,
        count,
        message: `"${key}=" appears ${count} times in this file. This tool reads and writes only the FIRST occurrence -- if the server itself reads a different one, changes here can appear to save while having no effect in-game. Open the raw INI editor to see and fix the duplicate.`,
      });
    }

    const availableModIds = new Set();
    const modIdToWorkshopId = new Map();
    const references = new Map();

    if (serverPath) {
      for (const wid of workshopIds) {
        const details = getModDetailsFromWorkshop(wid, serverPath);
        for (const mod of details) {
          availableModIds.add(mod.id);
          modIdToWorkshopId.set(mod.id, wid);
          if (mod.require) {
            references.set(mod.id, mod.require);
          }
        }
      }

      for (const mid of modIds) {
        if (!availableModIds.has(mid)) {
          if (mid !== "example") {
            warnings.push({
              type: "missing_source",
              modId: mid,
              message: `Mod ID '${mid}' is enabled but not found in any configured Workshop Item.`,
            });
          }
        }
      }

      for (const mid of modIds) {
        const requirements = references.get(mid);
        if (requirements) {
          for (const req of requirements) {
            if (!modIds.includes(req)) {
              errors.push({
                type: "missing_dependency",
                modId: mid,
                dependency: req,
                message: `Mod '${mid}' requires '${req}' but it is not enabled.`,
              });
            }
          }
        }
      }
    } else {
      warnings.push({
        type: "config",
        message: "Server path not configured - cannot validate files on disk.",
      });
    }

    res.json({
      valid: errors.length === 0,
      errors,
      warnings,
      stats: {
        workshopItems: workshopIds.length,
        enabledMods: modIds.length,
        availableMods: availableModIds.size,
      },
    });
  } catch (error) {
    log.error(`Failed to validate config: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/presets", async (req, res) => {
  try {
    const presets = await getModPresets();
    res.json({ presets });
  } catch (error) {
    log.error(`Failed to get mod presets: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/presets", async (req, res) => {
  try {
    let { name, description } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({
        error: "Preset name is required",
        code: ErrorCode.MODS_PRESET_NAME_REQUIRED,
      });
    }
    name = name.trim();
    if (!name || name.length > 100) {
      return res.status(400).json({
        error: "Preset name must be 1-100 characters",
        code: ErrorCode.MODS_PRESET_NAME_LENGTH_INVALID,
      });
    }
    if (description && typeof description === "string") {
      description = description.trim().slice(0, 500);
    } else {
      description = "";
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

    if (!iniPath) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    const content = readTextFile(iniPath);
    const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);

    const workshopIds = workshopMatch
      ? workshopMatch[1].split(";").filter(Boolean)
      : [];
    const modIds = modsMatch ? modsMatch[1].split(";").filter(Boolean) : [];

    const preset = await createModPreset(
      name,
      description,
      modIds,
      workshopIds,
    );

    log.info(
      `Created mod preset "${name}" with ${workshopIds.length} workshop items and ${modIds.length} mod IDs`,
    );
    res.json({ preset, message: `Preset "${name}" created successfully` });
  } catch (error) {
    log.error(`Failed to create mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put("/presets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        error: "Invalid preset ID",
        code: ErrorCode.MODS_INVALID_PRESET_ID,
      });
    }

    const updates = {};
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string")
        return res.status(400).json({
          error: "name must be a string",
          code: ErrorCode.MODS_PRESET_UPDATE_NAME_STRING_REQUIRED,
        });
      const trimmed = req.body.name.trim();
      if (!trimmed || trimmed.length > 100)
        return res.status(400).json({
          error: "name must be 1-100 characters",
          code: ErrorCode.MODS_PRESET_UPDATE_NAME_LENGTH_INVALID,
        });
      updates.name = trimmed;
    }
    if (req.body.description !== undefined) {
      updates.description =
        typeof req.body.description === "string"
          ? req.body.description.trim().slice(0, 500)
          : "";
    }
    if (req.body.workshopIds !== undefined) {
      if (!Array.isArray(req.body.workshopIds))
        return res.status(400).json({
          error: "workshopIds must be an array",
          code: ErrorCode.MODS_PRESET_UPDATE_WORKSHOP_IDS_ARRAY,
        });
      updates.workshop_ids = req.body.workshopIds;
    }
    if (req.body.modIds !== undefined) {
      if (!Array.isArray(req.body.modIds))
        return res.status(400).json({
          error: "modIds must be an array",
          code: ErrorCode.MODS_MOD_IDS_ARRAY_REQUIRED,
        });
      updates.mods = req.body.modIds;
    }

    const preset = await updateModPreset(id, updates);
    if (!preset) {
      return res.status(404).json({
        error: "Preset not found",
        code: ErrorCode.MODS_PRESET_NOT_FOUND,
      });
    }

    log.info(`Updated mod preset: ${updates.name || id}`);
    res.json({ preset, message: "Preset updated successfully" });
  } catch (error) {
    log.error(`Failed to update mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/presets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        error: "Invalid preset ID",
        code: ErrorCode.MODS_INVALID_PRESET_ID,
      });
    }

    const deleted = await deleteModPreset(id);

    if (!deleted) {
      return res.status(404).json({
        error: "Preset not found",
        code: ErrorCode.MODS_PRESET_NOT_FOUND,
      });
    }

    log.info(`Deleted mod preset: ${id}`);
    res.json({ message: "Preset deleted successfully" });
  } catch (error) {
    log.error(`Failed to delete mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/presets/:id/apply", async (req, res) => {
  try {
    const { id } = req.params;
    const presets = await getModPresets();
    const preset = presets.find((p) => String(p.id) === String(id));

    if (!preset) {
      return res.status(404).json({
        error: "Preset not found",
        code: ErrorCode.MODS_PRESET_NOT_FOUND,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

    if (!iniPath) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const workshopLine = `WorkshopItems=${sanitizeIniList(preset.workshop_ids || [])}`;
      if (content.match(/^[ \t]*WorkshopItems[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*WorkshopItems[ \t]*=.*/m, workshopLine);
      } else {
        content += `\n${workshopLine}`;
      }

      const modsLine = `Mods=${sanitizeIniList(preset.mods || [])}`;
      if (content.match(/^[ \t]*Mods[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, modsLine);
      } else {
        content += `\n${modsLine}`;
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    log.info(
      `Applied mod preset "${preset.name}": ${(preset.workshop_ids || []).length} workshop items, ${(preset.mods || []).length} mod IDs`,
    );
    res.json({
      message: `Preset "${preset.name}" applied successfully`,
      workshopCount: (preset.workshop_ids || []).length,
      modCount: (preset.mods || []).length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to apply mod preset: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/save-order", async (req, res) => {
  try {
    const { modIds } = req.body;

    if (!Array.isArray(modIds)) {
      return res.status(400).json({
          error: "modIds must be an array",
          code: ErrorCode.MODS_MOD_IDS_ARRAY_REQUIRED,
        });
    }
    if (modIds.length > 2000) {
      return res.status(400).json({
        error: "Too many mod IDs (max 2000)",
        code: ErrorCode.MODS_SAVE_ORDER_TOO_MANY,
      });
    }
    for (const id of modIds) {
      if (typeof id !== "string" || id.length > 200) {
        return res.status(400).json({
          error: "Each mod ID must be a string (max 200 chars)",
          code: ErrorCode.MODS_SAVE_ORDER_MODID_STRING_REQUIRED,
        });
      }
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);

    if (!iniPath) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const modsLine = `Mods=${sanitizeIniList(modIds)}`;
      if (content.match(/^[ \t]*Mods[ \t]*=.*/m)) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, modsLine);
      } else {
        content += `\n${modsLine}`;
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    log.info(`Saved mod load order: ${modIds.length} mods`);
    res.json({
      message: "Mod load order saved successfully",
      modCount: modIds.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to save mod order: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/discover-mod-ids", async (req, res) => {
  try {
    const { workshopId, workshopUrl } = req.body;

    let wsId = workshopId;
    if (!wsId && workshopUrl) {
      const urlMatch = workshopUrl.match(/id=(\d+)/);
      if (urlMatch) {
        wsId = urlMatch[1];
      }
    }

    if (!wsId) {
      return res.status(400).json({
        error: "Workshop ID or URL is required",
        code: ErrorCode.MODS_DISCOVER_WORKSHOP_ID_OR_URL_REQUIRED,
      });
    }

    if (!/^\d{1,15}$/.test(String(wsId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const serverPath = await getServerPath();
    const discoveredModIds = [];
    const sources = [];

    if (serverPath) {
      const localModIds = findAllModIdsFromWorkshop(String(wsId), serverPath);
      for (const modId of localModIds) {
        if (!discoveredModIds.includes(modId)) {
          discoveredModIds.push(modId);
          sources.push({ modId, source: "local-files" });
        }
      }
    }

    let modInfo = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            itemcount: "1",
            "publishedfileids[0]": wsId,
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        modInfo = data.response?.publishedfiledetails?.[0];

        if (modInfo && modInfo.result !== 1) {
          log.warn(
            `Steam API returned error for workshop ${wsId}: result=${modInfo.result}`,
          );
          modInfo = null;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        log.warn(`Steam API request timed out for workshop ${wsId}`);
      } else {
        log.warn(
          `Failed to fetch Steam API for workshop ${wsId}: ${e.message}`,
        );
      }
    }

    if (modInfo && modInfo.result === 1 && discoveredModIds.length === 0) {
      const description = modInfo.description || "";

      const patterns = [
        // Pattern: "Mod ID: SomeName" or "ModID: SomeName" (can appear multiple times)
        /Mod\s*ID\s*[:=]\s*([A-Za-z0-9_-]+)/gi,
        // Pattern: "id=SomeName"
        /\bid\s*=\s*([A-Za-z0-9_-]+)/gi,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(description)) !== null) {
          const modId = match[1].trim();
          if (!/^\d{1,15}$/.test(modId) && !discoveredModIds.includes(modId)) {
            discoveredModIds.push(modId);
            sources.push({ modId, source: "steam-description" });
          }
        }
      }
    }

    const uniqueModIds = [...new Set(discoveredModIds)];

    let mapFolders = [];
    if (serverPath) {
      mapFolders = findMapFoldersFromWorkshop(String(wsId), serverPath);
    }

    const isMap =
      modInfo?.tags?.some(
        (t) =>
          t.tag?.toLowerCase() === "map" || t.tag?.toLowerCase() === "maps",
      ) || mapFolders.length > 0;

    res.json({
      success: true,
      workshopId: wsId,
      name: modInfo?.title || `Workshop Mod ${wsId}`,
      description: modInfo?.description?.substring(0, 500) || null,
      modIds: uniqueModIds,
      hasMultipleModIds: uniqueModIds.length > 1,
      sources,
      isMap,
      mapFolders,
      isDownloaded: serverPath
        ? findAllModIdsFromWorkshop(String(wsId), serverPath).length > 0
        : false,
      tags: modInfo?.tags?.map((t) => t.tag) || [],
    });
  } catch (error) {
    log.error(`Failed to discover mod IDs: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/add-mod-advanced", async (req, res) => {
  try {
    const { workshopId, selectedModIds, includeAllModIds } = req.body;

    if (!workshopId) {
      return res.status(400).json({
        error: "Workshop ID is required",
        code: ErrorCode.MODS_WORKSHOP_ID_REQUIRED,
      });
    }

    if (!selectedModIds && !includeAllModIds) {
      return res.status(400).json({
        error: "Either selectedModIds or includeAllModIds is required",
        code: ErrorCode.MODS_ADD_ADVANCED_SELECTION_REQUIRED,
      });
    }

    if (!/^\d{1,15}$/.test(String(workshopId))) {
      return res.status(400).json({
        error: "Invalid Workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_CAP,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }

    const sanitizedServerName = path.basename(serverName);
    if (
      !sanitizedServerName ||
      sanitizedServerName !== serverName ||
      serverName.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }

    const iniPath = path.join(serverConfigPath, `${sanitizedServerName}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file not found",
        code: ErrorCode.MODS_CONFIG_FILE_NOT_FOUND,
      });
    }

    let modIdsToAdd = selectedModIds || [];
    for (const modId of modIdsToAdd) {
      if (
        typeof modId !== "string" ||
        !modId.trim() ||
        /[\r\n;=]/.test(modId) ||
        modId.length > 200
      ) {
        const truncatedModId = String(modId).substring(0, 50);
        return res.status(400).json({
          error: `Invalid mod ID format: ${truncatedModId}`,
          code: ErrorCode.MODS_INVALID_MOD_ID_FORMAT_TEMPLATE,
          params: sanitizeErrorParams({ modId: truncatedModId }),
        });
      }
    }

    if (includeAllModIds && serverPath) {
      const allModIds = findAllModIdsFromWorkshop(
        String(workshopId),
        serverPath,
      );
      modIdsToAdd = [...new Set([...modIdsToAdd, ...allModIds])];
    }

    let modMapFolders = [];
    if (serverPath) {
      modMapFolders = findMapFoldersFromWorkshop(
        String(workshopId),
        serverPath,
      );
    }

    let addedMapFolders = [];
    const lockResult = await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const workshopMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const currentWorkshopIds =
        workshopMatch?.[1]?.split(";").filter(Boolean) || [];
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const currentModIds = modsMatch?.[1]?.split(";").filter(Boolean) || [];

      const workshopAlreadyExists = currentWorkshopIds.includes(
        String(workshopId),
      );
      if (!workshopAlreadyExists) {
        currentWorkshopIds.push(String(workshopId));
      }

      const addedModIds = [];
      for (const modId of modIdsToAdd) {
        if (!currentModIds.includes(modId)) {
          currentModIds.push(modId);
          addedModIds.push(modId);
        }
      }

      const newWorkshopList = sanitizeIniList(currentWorkshopIds);
      const newModList = sanitizeModIdList(currentModIds);

      if (workshopMatch) {
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          `WorkshopItems=${newWorkshopList}`,
        );
      } else {
        content += `\nWorkshopItems=${newWorkshopList}`;
      }

      if (modsMatch) {
        content = content.replace(/^[ \t]*Mods[ \t]*=.*/m, `Mods=${newModList}`);
      } else {
        content += `\nMods=${newModList}`;
      }

      if (modMapFolders.length > 0) {
        const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
        let currentMaps = mapMatch?.[1]?.split(";").filter(Boolean) || [
          "Muldraugh, KY",
        ];

        for (const folder of modMapFolders) {
          if (!currentMaps.includes(folder)) {
            currentMaps.unshift(folder);
            addedMapFolders.push(folder);
          }
        }

        const newMapList = currentMaps.join(";");
        if (mapMatch) {
          content = content.replace(/^[ \t]*Map[ \t]*=.*/m, `Map=${newMapList}`);
        } else {
          content += `\nMap=${newMapList}`;
        }
      }

      const backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
      return {
        addedModIds,
        totalModIdsInConfig: currentModIds.length,
        workshopAlreadyExisted: workshopAlreadyExists,
        backupWarning,
      };
    });

    try {
      await removeIgnoredMod(String(workshopId));
      await addTrackedMod(String(workshopId), `Workshop Mod ${workshopId}`);
    } catch (e) {
      // Ignore if already tracked
    }

    autoSyncCollection("add", String(workshopId)).catch(() => {});

    log.info(
      `Added mod ${workshopId} with ${lockResult.addedModIds.length} mod IDs: ${lockResult.addedModIds.join(", ")}`,
    );

    res.json({
      success: true,
      workshopId,
      addedModIds: lockResult.addedModIds,
      totalModIdsInConfig: lockResult.totalModIdsInConfig,
      workshopAlreadyExisted: lockResult.workshopAlreadyExisted,
      mapFoldersAdded: addedMapFolders,
      message:
        lockResult.addedModIds.length > 0
          ? `Added ${lockResult.addedModIds.length} mod ID(s): ${lockResult.addedModIds.join(", ")}`
          : "Workshop ID added (mod IDs were already configured)",
      ...(lockResult.backupWarning ? { backupWarning: lockResult.backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to add mod advanced: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


let conflictScanInFlight = false;
let conflictScanStartedAt = 0;
const SCAN_MUTEX_TIMEOUT_MS = 5 * 60 * 1000;

let lastScanResult = null;
let lastScanWorkshopSnapshot = null;
let lastScanModSnapshot = null;
let lastScanServerPath = null;

export function createConflictScanSnapshots(workshopIds, modIds) {
  return {
    workshop: workshopIds.slice().sort().join(","),
    mods: modIds.join(","),
  };
}
let lastScanTimestamp = 0;
let scanLockToken = 0;
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;

function acquireScanLock() {
  if (
    conflictScanInFlight &&
    Date.now() - conflictScanStartedAt > SCAN_MUTEX_TIMEOUT_MS
  ) {
    log.warn("Conflict scan mutex was stuck for >5 min — auto-resetting");
    conflictScanInFlight = false;
  }
  if (conflictScanInFlight) return null;
  conflictScanInFlight = true;
  conflictScanStartedAt = Date.now();
  return ++scanLockToken;
}

function releaseScanLock(token) {
  if (token !== scanLockToken) return;
  conflictScanInFlight = false;
  conflictScanStartedAt = 0;
}

const HASH_MAX_BYTES = 50 * 1024 * 1024;

const WALK_MAX_DEPTH = 20;
const WALK_MAX_FILES = 50_000;

// Global cap on how many entries buildFileIndex() will accumulate across ALL
export const FILE_INDEX_MAX_ENTRIES = 300_000;
export const CONFLICT_PAIR_FILE_MAX_ENTRIES = 100_000;
const WALK_SKIP_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  "node_modules",
  ".vscode",
]);

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    log.debug(`Could not resolve ${p}: ${e.message}`);
    return null;
  }
}

function isInsideRoot(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

const WALK_YIELD_EVERY = 1000;

async function walkDir(dir, prefix = "", _depth = 0, _ctx = null) {
  const ctx = _ctx || {
    left: WALK_MAX_FILES,
    root: safeRealpath(dir) || dir,
    sinceYield: 0,
  };
  const results = [];
  let truncated = false;
  if (_depth > WALK_MAX_DEPTH) return { files: results, truncated };
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log.debug(`walkDir: could not read ${dir}: ${e.message}`);
    return { files: results, truncated };
  }
  for (const entry of entries) {
    if (ctx.left <= 0) {
      truncated = true;
      break;
    }
    if (++ctx.sinceYield >= WALK_YIELD_EVERY) {
      ctx.sinceYield = 0;
      await yieldTick();
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      const real = safeRealpath(fullPath);
      if (!real || !isInsideRoot(real, ctx.root)) continue;
      try {
        isDirectory = (await fs.promises.stat(real)).isDirectory();
      } catch (e) {
        log.debug(`walkDir: could not stat link ${fullPath}: ${e.message}`);
        continue;
      }
    }
    if (isDirectory) {
      if (WALK_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const sub = await walkDir(fullPath, rel, _depth + 1, ctx);
      results.push(...sub.files);
      if (sub.truncated) truncated = true;
    } else {
      ctx.left--;
      results.push(rel);
    }
  }
  return { files: results, truncated };
}

function classifyFile(relPath) {
  const lower = relPath.toLowerCase();
  const basename = lower.split("/").pop();

  if (basename === "sandbox-options.txt") return "sandbox-options";
  if (basename === "fileguidtable.xml") return "fileguidtable";

  if (lower.startsWith("lua/")) {
    if (lower.startsWith("lua/server/")) return "lua-server";
    if (lower.startsWith("lua/client/")) return "lua-client";
    if (lower.startsWith("lua/shared/translate/")) return "translate";
    if (lower.startsWith("lua/shared/")) return "lua-shared";
    return "lua-other";
  }

  if (lower.startsWith("scripts/")) return "scripts";

  if (lower.startsWith("clothing/")) return "clothing";

  if (lower.startsWith("maps/")) return "maps";
  if (
    lower.startsWith("texturepacks/") ||
    lower.startsWith("textures/") ||
    lower.endsWith(".pack")
  )
    return "textures";
  if (lower.startsWith("ui/")) return "ui-assets";
  if (lower.startsWith("sound/") || lower.startsWith("music/")) return "audio";
  if (
    lower.startsWith("models/") ||
    lower.startsWith("models_x/") ||
    lower.endsWith(".fbx") ||
    lower.endsWith(".x")
  )
    return "models";
  if (lower.endsWith(".png") || lower.endsWith(".jpg")) return "textures";
  if (lower.endsWith(".xml") || lower.endsWith(".txt")) return "data";
  return "other";
}

const SEVERITY_MAP = {
  "lua-server": "high",
  "lua-shared": "high",
  "lua-client": "high",
  "lua-other": "high",
  "lua-cross-file": "high",
  scripts: "medium",
  clothing: "medium",
  "sandbox-options": "low",
  fileguidtable: "low",
  translate: "low",
  maps: "medium",
  textures: "low",
  "ui-assets": "low",
  models: "low",
  audio: "low",
  data: "medium",
  other: "low",
};

const CATEGORY_LABELS = {
  "lua-server": "Server Lua Scripts",
  "lua-shared": "Shared Lua Scripts",
  "lua-client": "Client Lua Scripts",
  "lua-other": "Lua Scripts",
  "lua-cross-file": "Lua Symbol Clash (same workshop, different files)",
  scripts: "Item/Recipe/Vehicle Scripts",
  clothing: "Clothing Definitions",
  "sandbox-options": "Sandbox Options",
  fileguidtable: "Mod Editor Metadata",
  translate: "Translation Files",
  maps: "Map Data",
  textures: "Texture Packs",
  "ui-assets": "UI Assets",
  models: "3D Models",
  audio: "Audio",
  data: "Data Files",
  other: "Other Files",
};

function extractTranslationKeys(filePath) {
  try {
    const content = stripBom(fs.readFileSync(filePath, "utf-8"));
    const keys = new Set();
    const re = /^\s*([A-Za-z_]\w*)\s*=\s*(?:"|'|\[\[)/gm;
    let m;
    while ((m = re.exec(content)) !== null) keys.add(m[1]);
    return keys;
  } catch (e) {
    log.debug(`Error parsing translation file ${filePath}: ${e.message}`);
    return null;
  }
}

export function compareDefinitionSets(modEntries, extract) {
  const parsed = [];
  let unparsable = 0;
  for (const entry of modEntries) {
    const defs = extract(entry.absPath);
    if (!defs) {
      unparsable++;
      continue;
    }
    parsed.push({ mod: entry, defs });
  }
  const overlapping = new Set();
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      if (parsed[i].mod.modId === parsed[j].mod.modId) continue;
      const [small, large] =
        parsed[i].defs.size <= parsed[j].defs.size
          ? [parsed[i].defs, parsed[j].defs]
          : [parsed[j].defs, parsed[i].defs];
      for (const d of small) if (large.has(d)) overlapping.add(d);
    }
  }
  if (overlapping.size > 0) {
    return {
      disjoint: false,
      overlapping: [...overlapping],
      inconclusive: false,
    };
  }
  const distinctParsedMods = new Set(parsed.map((p) => p.mod.modId)).size;
  const inconclusive = unparsable > 0 || distinctParsedMods < 2;
  return { disjoint: !inconclusive, overlapping: [], inconclusive };
}

function compareTranslationKeys(modEntries) {
  return compareDefinitionSets(modEntries, extractTranslationKeys);
}

function extractScriptDefinitions(filePath) {
  try {
    const content = stripBom(fs.readFileSync(filePath, "utf-8"));
    if (content.length > 2 * 1024 * 1024) return null;
    const defs = new Set();
    const moduleRe = /module\s+(\w+)\s*\{/g;
    let moduleMatch;
    while ((moduleMatch = moduleRe.exec(content)) !== null) {
      const moduleName = moduleMatch[1];
      const moduleStart = moduleMatch.index + moduleMatch[0].length;
      let depth = 1;
      let pos = moduleStart;
      while (pos < content.length && depth > 0) {
        if (content[pos] === "{") depth++;
        else if (content[pos] === "}") depth--;
        pos++;
      }
      const moduleBody = content.slice(moduleStart, pos - 1);
      const defRe =
        /^\s*(item|recipe|craftrecipe|vehicle|fixing|model|sound|animation|mannequin|evolvedrecipe|uniquerecipe|multistagebuild|entity|xuiskin|componenttemplate|bodylocation|wallpaper|material|template|electrical|liquid|liquidvacuumdef|stash|profession|trait|bodypart)\s+(\S+)/gim;
      let defMatch;
      while ((defMatch = defRe.exec(moduleBody)) !== null) {
        defs.add(`${moduleName}.${defMatch[1].toLowerCase()}.${defMatch[2]}`);
      }
    }
    return defs;
  } catch (e) {
    log.debug(`Error parsing script file ${filePath}: ${e.message}`);
    return null;
  }
}

function compareScriptDefinitions(modEntries) {
  return compareDefinitionSets(modEntries, extractScriptDefinitions);
}

function extractClothingDefinitions(filePath) {
  try {
    const content = stripBom(fs.readFileSync(filePath, "utf-8"));
    if (content.length > 2 * 1024 * 1024) return null;
    const defs = new Set();
    const modelRe =
      /<m_(?:Male|Female)Model>\s*([^<]+)\s*<\/m_(?:Male|Female)Model>/gi;
    let m;
    while ((m = modelRe.exec(content)) !== null) {
      defs.add(m[1].trim().toLowerCase());
    }
    const nameRe = /<m_Name>\s*([^<]+)\s*<\/m_Name>/gi;
    while ((m = nameRe.exec(content)) !== null) {
      defs.add(m[1].trim().toLowerCase());
    }
    return defs;
  } catch (e) {
    log.debug(`Error parsing clothing file ${filePath}: ${e.message}`);
    return null;
  }
}

function compareClothingDefinitions(modEntries) {
  return compareDefinitionSets(modEntries, extractClothingDefinitions);
}

function extractLuaSymbols(filePath) {
  try {
    const content = stripBom(fs.readFileSync(filePath, "utf-8"));
    if (content.length > 2 * 1024 * 1024) return null;
    const stripped = content
      .replace(/--\[\[[\s\S]*?\]\]/g, "")
      .replace(/--[^\n]*/g, "");
    const symbols = new Set();
    let m;
    const fnRe = /(?:^|\n)\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/g;
    while ((m = fnRe.exec(stripped)) !== null) symbols.add(`fn:${m[1]}`);
    const assignFnRe = /(?:^|\n)\s*([A-Za-z_][\w.]*)\s*=\s*function\s*\(/g;
    while ((m = assignFnRe.exec(stripped)) !== null) symbols.add(`fn:${m[1]}`);
    const evRe = /\bEvents\.([A-Za-z_]\w*)\.(?:Add|Remove)\s*\(/g;
    while ((m = evRe.exec(stripped)) !== null) symbols.add(`event:${m[1]}`);
    const classRe =
      /(?:^|\n)\s*([A-Z][\w]*)\s*=\s*[A-Z][\w]*\s*:\s*derive\s*\(/g;
    while ((m = classRe.exec(stripped)) !== null) symbols.add(`class:${m[1]}`);
    return symbols;
  } catch (e) {
    log.debug(`Error parsing Lua file ${filePath}: ${e.message}`);
    return null;
  }
}

const LUA_SYMBOL_CACHE_MAX = 20_000;
const luaSymbolCache = new Map();

function getLuaSymbols(filePath) {
  const cached = luaSymbolCache.get(filePath);
  if (cached !== undefined) return cached;
  const symbols = extractLuaSymbols(filePath);
  if (luaSymbolCache.size < LUA_SYMBOL_CACHE_MAX)
    luaSymbolCache.set(filePath, symbols);
  return symbols;
}

function resetScanCaches() {
  luaSymbolCache.clear();
}

function compareLuaSymbols(modEntries) {
  const symsByMod = [];
  for (const entry of modEntries) {
    const s = getLuaSymbols(entry.absPath);
    if (!s || s.size === 0) continue;
    symsByMod.push({ mod: entry, symbols: s });
  }
  if (symsByMod.length < 2) return null;
  const overlapping = new Set();
  for (let i = 0; i < symsByMod.length; i++) {
    for (let j = i + 1; j < symsByMod.length; j++) {
      if (symsByMod[i].mod.modId === symsByMod[j].mod.modId) continue;
      for (const s of symsByMod[i].symbols)
        if (symsByMod[j].symbols.has(s)) overlapping.add(s);
    }
  }
  return { overlapping: [...overlapping], parsed: symsByMod.length };
}

const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

const LUA_CATEGORIES = new Set([
  "lua-server",
  "lua-shared",
  "lua-client",
  "lua-other",
]);

function dedupeByModId(entries) {
  const byId = new Map();
  for (const entry of entries) if (!byId.has(entry.modId)) byId.set(entry.modId, entry);
  return [...byId.values()];
}

function hashFileStreaming(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (e) => {
      log.debug(`Error hashing file ${filePath}: ${e.message}`);
      resolve(null);
    });
  });
}

async function compareFileContents(entries) {
  const sized = await Promise.all(
    entries.map(async (entry) => {
      try {
        return { entry, size: (await fsp.stat(entry.absPath)).size };
      } catch (e) {
        log.debug(`Error reading file size ${entry.absPath}: ${e.message}`);
        return null;
      }
    }),
  );
  const readable = sized.filter(Boolean);
  const unreadable = sized.length - readable.length;
  if (readable.length < 2) return "unknown";
  if (new Set(readable.map((r) => r.size)).size > 1) return "differs";
  if (readable[0].size > HASH_MAX_BYTES) return "differs";
  const hashes = await Promise.all(
    readable.map((r) => hashFileStreaming(r.entry.absPath)),
  );
  if (hashes.some((h) => h == null)) return "differs";
  if (new Set(hashes).size > 1) return "differs";
  return unreadable === 0 ? "identical" : "differs";
}

function hashFileSync(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > HASH_MAX_BYTES) return "too-large";
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(buf).digest("hex");
  } catch (e) {
    log.debug(`Error hashing file sync ${filePath}: ${e.message}`);
    return null;
  }
}

async function readIniModLists() {
  const serverConfigPath = await getServerConfigPath();
  const serverName = await getServerName();
  const iniPath = getSanitizedIniPath(serverConfigPath, serverName);
  let workshopIds = [];
  let modIdsFromIni = [];
  if (iniPath && fs.existsSync(iniPath)) {
    const iniContent = readTextFile(iniPath);
    const wsMatch = iniContent.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    const modsMatch = iniContent.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    if (wsMatch && wsMatch[1].trim()) {
      workshopIds = wsMatch[1]
        .trim()
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (modsMatch && modsMatch[1].trim()) {
      modIdsFromIni = modsMatch[1]
        .trim()
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { workshopIds, modIdsFromIni };
}

export async function buildFileIndex(
  workshopIds,
  serverPath,
  onModScanned,
  activeModIds,
  maxEntries = FILE_INDEX_MAX_ENTRIES,
) {
  const fileIndex = {};
  const modInfoMap = {};
  let modsScanned = 0;
  let modsNotFound = 0;
  let modsSkippedInactive = 0;
  let indexedEntries = 0;
  let indexTruncated = false;
  const warnings = [];
  const totalWorkshopIds = workshopIds.length;
  const activeSet = activeModIds ? new Set(activeModIds) : null;

  outer: for (let wsIdx = 0; wsIdx < totalWorkshopIds; wsIdx++) {
    if (indexTruncated) break;
    const wsId = workshopIds[wsIdx];
    if (!/^\d{1,15}$/.test(wsId)) {
      warnings.push(`Skipped invalid workshop ID: ${wsId.slice(0, 20)}`);
      continue;
    }
    const possiblePaths = getWorkshopPaths(wsId, serverPath);
    let workshopPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        workshopPath = p;
        break;
      }
    }
    if (!workshopPath) {
      modsNotFound++;
      continue;
    }
    const modDetails = getModDetailsFromWorkshop(wsId, serverPath);
    modInfoMap[wsId] = modDetails;
    const modsFolder = path.join(workshopPath, "mods");
    const searchBase = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
    let modEntries;
    try {
      modEntries = fs.readdirSync(searchBase, { withFileTypes: true });
    } catch (e) {
      log.debug(`Could not read mod directory ${searchBase}: ${e.message}`);
      continue;
    }
    let modsFoundInThisWs = 0;
    for (const modDir of modEntries) {
      if (indexTruncated) break;
      if (!modDir.isDirectory()) continue;
      const modDirPath = path.join(searchBase, modDir.name);
      const mediaPaths = [];
      const directMedia = path.join(modDirPath, "media");
      if (fs.existsSync(directMedia)) {
        mediaPaths.push(directMedia);
      } else {
        try {
          const subDirs = fs.readdirSync(modDirPath, { withFileTypes: true });
          for (const sub of subDirs) {
            if (!sub.isDirectory()) continue;
            if (/^(42(\.\d+)?|common)$/i.test(sub.name)) {
              const subMedia = path.join(modDirPath, sub.name, "media");
              if (fs.existsSync(subMedia)) mediaPaths.push(subMedia);
            }
          }
        } catch (e) {
          log.debug(
            `Could not scan B42 subfolders for ${modDirPath}: ${e.message}`,
          );
        }
      }
      if (mediaPaths.length === 0) continue;
      const matchingMod = modDetails.find(
        (m) => m.id === modDir.name || m.name === modDir.name,
      );
      const modId = matchingMod?.id || modDir.name;
      const modName = matchingMod?.name || modDir.name;
      if (activeSet && !activeSet.has(modId)) {
        modsSkippedInactive++;
        continue;
      }
      modsScanned++;
      modsFoundInThisWs++;
      let totalFileCount = 0;
      for (const mediaPath of mediaPaths) {
        if (indexTruncated) break;
        const { files, truncated } = await walkDir(mediaPath);
        if (truncated) {
          warnings.push(
            `${modName} (${wsId}): file scan hit the 50,000 file limit — some files were skipped`,
          );
        }
        totalFileCount += files.length;
        let sinceYield = 0;
        for (const relFile of files) {
          // Global cap (panel-oom-buildfileindex-unbounded): WALK_MAX_FILES
          if (indexedEntries >= maxEntries) {
            indexTruncated = true;
            break outer;
          }
          const normalizedPath = relFile.replace(/\\/g, "/").toLowerCase();
          if (!fileIndex[normalizedPath]) {
            fileIndex[normalizedPath] = [];
          }
          fileIndex[normalizedPath].push({
            workshopId: wsId,
            modId,
            modName,
            absPath: path.join(mediaPath, relFile),
          });
          indexedEntries++;
          if (++sinceYield >= WALK_YIELD_EVERY) {
            sinceYield = 0;
            await yieldTick();
          }
        }
      }
      if (onModScanned)
        onModScanned({
          modId,
          modName,
          workshopId: wsId,
          fileCount: totalFileCount,
          modsScanned,
          totalWorkshopIds,
          wsIdx,
        });
    }
    if (modsFoundInThisWs > 1) {
      log.debug(
        `Workshop ${wsId}: contains ${modsFoundInThisWs} mod dirs (${modInfoMap[wsId]?.map((m) => m.id).join(", ") || "unknown"})`,
      );
    }
    await yieldTick();
  }
  if (indexTruncated) {
    warnings.push(
      `File index reached the global ${maxEntries.toLocaleString()}-entry limit — the conflict scan is incomplete. Scan fewer mods at once or remove unused ones and retry.`,
    );
  }
  return {
    fileIndex,
    modInfoMap,
    modsScanned,
    modsNotFound,
    modsSkippedInactive,
    truncated: indexTruncated,
    warnings,
  };
}

async function detectConflicts(fileIndex, onConflictFound, options = {}) {
  const { shouldAbort, onProgress } = options;
  const conflicts = [];
  let identicalSkipped = 0;
  let additiveSkipped = 0;
  let pzAdditiveSkipped = 0;
  const pzAdditiveBreakdown = {
    sandbox: 0,
    scripts: 0,
    clothing: 0,
    fileguidtable: 0,
    translate: 0,
  };
  let processed = 0;
  const indexEntries = Object.entries(fileIndex);
  for (const [filePath, mods] of indexEntries) {
    if (shouldAbort && shouldAbort()) break;
    if (mods.length < 2) continue;
    const distinctMods = dedupeByModId(mods);
    if (distinctMods.length < 2) continue;
    const category = classifyFile(filePath);

    if (category === "sandbox-options" || category === "fileguidtable") {
      pzAdditiveSkipped++;
      pzAdditiveBreakdown[
        category === "sandbox-options" ? "sandbox" : "fileguidtable"
      ]++;
      continue;
    }

    const contentState = await compareFileContents(mods);
    if (++processed % 25 === 0) {
      if (onProgress) onProgress({ processed, total: indexEntries.length });
      await yieldTick();
    }
    if (contentState === "unknown") continue;
    if (contentState === "identical") {
      identicalSkipped++;
      continue;
    }

    const conflictMods = distinctMods.map((m) => ({
      workshopId: m.workshopId,
      modId: m.modId,
      modName: m.modName,
    }));


    if (category === "translate") {
      const comparison = compareTranslationKeys(mods);
      if (comparison.disjoint) {
        additiveSkipped++;
        pzAdditiveBreakdown.translate++;
        continue;
      }
      const conflict = {
        file: filePath,
        category,
        categoryLabel: CATEGORY_LABELS[category] || category,
        severity: "low",
        identical: false,
        mods: conflictMods,
      };
      if (comparison.overlapping.length > 0) {
        conflict.overlap = {
          kind: "translation-keys",
          items: comparison.overlapping.slice(0, 50),
          total: comparison.overlapping.length,
        };
      }
      conflicts.push(conflict);
      if (onConflictFound) onConflictFound(conflict);
      continue;
    }

    let scriptOverlap = null;
    if (category === "scripts") {
      const comparison = compareScriptDefinitions(mods);
      if (comparison.disjoint) {
        pzAdditiveSkipped++;
        pzAdditiveBreakdown.scripts++;
        continue;
      }
      scriptOverlap = comparison.overlapping;
      // Has overlapping defs — this IS a real conflict
    }

    let clothingOverlap = null;
    if (category === "clothing") {
      const comparison = compareClothingDefinitions(mods);
      if (comparison.disjoint) {
        pzAdditiveSkipped++;
        pzAdditiveBreakdown.clothing++;
        continue;
      }
      clothingOverlap = comparison.overlapping;
      // Has overlapping clothing IDs — real conflict
    }

    let luaOverlap = null;
    if (LUA_CATEGORIES.has(category)) {
      luaOverlap = compareLuaSymbols(mods);
    }

    const conflict = {
      file: filePath,
      category,
      categoryLabel: CATEGORY_LABELS[category] || category,
      severity: SEVERITY_MAP[category] || "low",
      identical: false,
      mods: conflictMods,
    };
    if (scriptOverlap && scriptOverlap.length > 0) {
      conflict.overlap = {
        kind: "script-defs",
        items: scriptOverlap.slice(0, 50),
        total: scriptOverlap.length,
      };
    } else if (clothingOverlap && clothingOverlap.length > 0) {
      conflict.overlap = {
        kind: "clothing-items",
        items: clothingOverlap.slice(0, 50),
        total: clothingOverlap.length,
      };
    } else if (luaOverlap) {
      if (luaOverlap.overlapping.length > 0) {
        conflict.overlap = {
          kind: "lua-symbols",
          items: luaOverlap.overlapping.slice(0, 50),
          total: luaOverlap.overlapping.length,
        };
      } else {
        conflict.severity = "medium";
        conflict.overlap = { kind: "lua-shadow", items: [], total: 0 };
      }
    }
    conflicts.push(conflict);
    if (onConflictFound) onConflictFound(conflict);
  }
  return {
    conflicts,
    identicalSkipped,
    additiveSkipped,
    pzAdditiveSkipped,
    pzAdditiveBreakdown,
  };
}

async function detectSameWorkshopLuaSymbolConflicts(
  fileIndex,
  existingConflicts,
  onConflictFound,
  options = {},
) {
  const { shouldAbort } = options;
  const coveredPairs = new Set();
  for (const c of existingConflicts) {
    const ids = [...new Set(c.mods.map((m) => m.modId))].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        coveredPairs.add(`${ids[i]}|${ids[j]}`);
      }
    }
  }

  const wsModFiles = {};
  for (const [relPath, mods] of Object.entries(fileIndex)) {
    if (!LUA_CATEGORIES.has(classifyFile(relPath))) continue;
    for (const m of mods) {
      if (!wsModFiles[m.workshopId]) wsModFiles[m.workshopId] = {};
      if (!wsModFiles[m.workshopId][m.modId])
        wsModFiles[m.workshopId][m.modId] = [];
      wsModFiles[m.workshopId][m.modId].push({
        relPath,
        absPath: m.absPath,
        modName: m.modName,
      });
    }
  }

  const conflicts = [];
  let scanned = 0;
  let parsed = 0;
  for (const [wsId, modFilesMap] of Object.entries(wsModFiles)) {
    if (shouldAbort && shouldAbort()) break;
    const modIds = Object.keys(modFilesMap);
    if (modIds.length < 2) continue;

    const symsByMod = {};
    for (const modId of modIds) {
      const symMap = new Map();
      for (const f of modFilesMap[modId]) {
        if (++parsed % 50 === 0) await yieldTick();
        const syms = getLuaSymbols(f.absPath);
        if (!syms || syms.size === 0) continue;
        for (const s of syms) {
          if (!symMap.has(s))
            symMap.set(s, { relPath: f.relPath, modName: f.modName });
        }
      }
      symsByMod[modId] = symMap;
    }

    for (let i = 0; i < modIds.length; i++) {
      for (let j = i + 1; j < modIds.length; j++) {
        const idA = modIds[i],
          idB = modIds[j];
        const pairKey = [idA, idB].sort().join("|");
        if (coveredPairs.has(pairKey)) continue;
        const symsA = symsByMod[idA];
        const symsB = symsByMod[idB];
        if (!symsA || !symsB || symsA.size === 0 || symsB.size === 0) continue;

        const overlap = [];
        for (const s of symsA.keys()) {
          if (symsB.has(s)) overlap.push(s);
        }
        if (overlap.length === 0) continue;

        const firstSym = overlap[0];
        const fileA = symsA.get(firstSym);
        const fileB = symsB.get(firstSym);
        const conflict = {
          file:
            fileA.relPath === fileB.relPath
              ? fileA.relPath
              : `${fileA.relPath} ↔ ${fileB.relPath}`,
          category: "lua-cross-file",
          categoryLabel: CATEGORY_LABELS["lua-cross-file"],
          severity: "high",
          identical: false,
          crossFile: true,
          overlap: {
            kind: "lua-symbols",
            items: overlap.slice(0, 50),
            total: overlap.length,
          },
          mods: [
            { workshopId: wsId, modId: idA, modName: fileA.modName },
            { workshopId: wsId, modId: idB, modName: fileB.modName },
          ],
        };
        conflicts.push(conflict);
        if (onConflictFound) onConflictFound(conflict);
        if (++scanned % 20 === 0) await yieldTick();
      }
    }
  }
  return conflicts;
}

export function groupIntoPairs(
  conflicts,
  maxFileEntries = CONFLICT_PAIR_FILE_MAX_ENTRIES,
) {
  const pairConflicts = {};
  let groupedFileEntries = 0;
  let truncated = false;
  outer: for (const conflict of conflicts) {
    const modIds = [...new Set(conflict.mods.map((m) => m.modId))].sort();
    for (let i = 0; i < modIds.length; i++) {
      for (let j = i + 1; j < modIds.length; j++) {
        if (groupedFileEntries >= maxFileEntries) {
          truncated = true;
          break outer;
        }
        const pairKey = `${modIds[i]}|${modIds[j]}`;
        if (!pairConflicts[pairKey]) {
          pairConflicts[pairKey] = {
            modA: conflict.mods.find((m) => m.modId === modIds[i]),
            modB: conflict.mods.find((m) => m.modId === modIds[j]),
            files: [],
            highCount: 0,
            mediumCount: 0,
            lowCount: 0,
            aWins: 0,
            bWins: 0,
            thirdPartyWins: 0,
            unknownWins: 0,
          };
        }
        pairConflicts[pairKey].files.push({
          file: conflict.file,
          category: conflict.category,
          categoryLabel: conflict.categoryLabel,
          severity: conflict.severity,
          winner: conflict.winner || null,
          overlap: conflict.overlap || null,
        });
        groupedFileEntries++;
        const severityKey = `${conflict.severity}Count`;
        if (severityKey in pairConflicts[pairKey])
          pairConflicts[pairKey][severityKey]++;
        if (conflict.winner == null) pairConflicts[pairKey].unknownWins++;
        else if (conflict.winner.modId === modIds[i])
          pairConflicts[pairKey].aWins++;
        else if (conflict.winner.modId === modIds[j])
          pairConflicts[pairKey].bWins++;
        else pairConflicts[pairKey].thirdPartyWins++;
      }
    }
  }
  return {
    pairs: Object.values(pairConflicts).sort(
      (a, b) =>
        b.highCount - a.highCount ||
        b.mediumCount - a.mediumCount ||
        b.files.length - a.files.length,
    ),
    truncated,
    groupedFileEntries,
  };
}

function annotateWinners(conflicts, modLoadOrder) {
  const order = new Map(modLoadOrder.map((id, i) => [id, i]));
  for (const c of conflicts) {
    let bestIdx = -1;
    let winner = null;
    for (const m of c.mods) {
      const idx = order.get(m.modId);
      if (idx == null) continue;
      if (idx > bestIdx) {
        bestIdx = idx;
        winner = m;
      }
    }
    c.winner = winner
      ? {
          modId: winner.modId,
          modName: winner.modName,
          workshopId: winner.workshopId,
        }
      : null;
  }
}

function findIdCollisions(modInfoMap, modIdsFromIni) {
  const activeSet = new Set(modIdsFromIni);
  const byModId = new Map();
  for (const [wsId, details] of Object.entries(modInfoMap)) {
    for (const mod of details) {
      if (!byModId.has(mod.id)) byModId.set(mod.id, []);
      byModId.get(mod.id).push({
        workshopId: wsId,
        modName: mod.name,
        active: activeSet.has(mod.id),
      });
    }
  }
  const collisions = [];
  for (const [modId, sources] of byModId.entries()) {
    const distinctWs = [
      ...new Map(sources.map((s) => [s.workshopId, s])).values(),
    ];
    if (distinctWs.length > 1) {
      collisions.push({
        modId,
        active: distinctWs.some((s) => s.active),
        sources: distinctWs,
      });
    }
  }
  return collisions;
}

function findMissingDeps(modInfoMap, modIdsFromIni, serverPath) {
  const activeModSet = new Set(modIdsFromIni);
  const dependencies = {};
  for (const [wsId, details] of Object.entries(modInfoMap)) {
    for (const mod of details) {
      if (mod.require?.length > 0 && activeModSet.has(mod.id)) {
        dependencies[mod.id] = {
          modId: mod.id,
          modName: mod.name,
          workshopId: wsId,
          requires: mod.require,
        };
      }
    }
  }
  const builtInMods = new Set([
    "Base",
    "base",
    "Farming",
    "Radio",
    "Camping",
    "Trapping",
    "Fishing",
    "Foraging",
    "Erosion",
    // B42 additions
    "Animal",
    "NPCs",
    "Seasons",
    "FireFighting",
    "FeedingTrough",
    "RainBarrel",
    "Vehicles",
    "Zombies",
    "XpSystem",
    "HealthSystem",
    "Professions",
    "Climate",
  ]);
  const allModIds = new Set(builtInMods);
  for (const id of modIdsFromIni) allModIds.add(id);
  const missingDeps = [];
  for (const [modId, depInfo] of Object.entries(dependencies)) {
    for (const req of depInfo.requires) {
      if (allModIds.has(req)) continue;
      const reqLower = req.toLowerCase();
      const variantMatch = Array.from(allModIds).find((id) => {
        const lower = id.toLowerCase();
        return (
          lower.startsWith(reqLower + "_") || lower.startsWith(reqLower + "-")
        );
      });
      if (variantMatch) continue;
      missingDeps.push({
        modId,
        modName: depInfo.modName,
        workshopId: depInfo.workshopId,
        missingDep: req,
      });
    }
  }

  if (serverPath && missingDeps.length > 0) {
    const missingIds = new Set(missingDeps.map((d) => d.missingDep));
    const resolved = new Map();
    const workshopPaths = [
      path.join(serverPath, "steamapps", "workshop", "content", "108600"),
      path.join(serverPath, "..", "steamapps", "workshop", "content", "108600"),
    ];
    for (const workshopBase of workshopPaths) {
      if (!fs.existsSync(workshopBase)) continue;
      try {
        for (const entry of fs.readdirSync(workshopBase, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || resolved.size === missingIds.size)
            continue;
          try {
            const details = getModDetailsFromWorkshop(entry.name, serverPath);
            for (const mod of details) {
              if (missingIds.has(mod.id) && !resolved.has(mod.id)) {
                resolved.set(mod.id, {
                  workshopId: entry.name,
                  modName: mod.name,
                });
              }
            }
          } catch (e) {
            log.debug(`Workshop folder unreadable ${entry.name}: ${e.message}`);
          }
        }
      } catch (e) {
        log.debug(`Workshop path inaccessible: ${e.message}`);
      }
      if (resolved.size === missingIds.size) break;
    }
    for (const dep of missingDeps) {
      const match = resolved.get(dep.missingDep);
      if (match) {
        dep.resolvedWorkshopId = match.workshopId;
        dep.resolvedModName = match.modName;
      }
    }
  }

  return missingDeps;
}

async function findSteamDeps(workshopIds) {
  const steamApiKey = await getSteamApiKey();
  if (
    !steamApiKey ||
    typeof steamApiKey !== "string" ||
    steamApiKey.length < 10
  )
    return {
      deps: [],
      warnings: [
        "Steam API key not configured — dependency check skipped. Set it in Settings to enable.",
      ],
    };

  const configuredWsIds = new Set(workshopIds.map(String));
  const allDeps = [];
  const steamWarnings = [];
  let steamApiFailed = false;

  for (let i = 0; i < workshopIds.length; i += 50) {
    const batch = workshopIds.slice(i, i + 50);
    const params = new URLSearchParams({
      key: steamApiKey,
      includechildren: "true",
    });
    batch.forEach((id, idx) =>
      params.append(`publishedfileids[${idx}]`, String(id)),
    );
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(
        `https://api.steampowered.com/IPublishedFileService/GetDetails/v1/?${params}`,
        {
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);
      if (!response.ok) {
        steamApiFailed = true;
        continue;
      }
      const data = await response.json();
      const details = data.response?.publishedfiledetails || [];
      for (const item of details) {
        if (!item.publishedfileid || !item.children?.length) continue;
        const parentWsId = String(item.publishedfileid);
        const parentName = item.title || `Workshop ${parentWsId}`;
        for (const child of item.children) {
          if (child.file_type !== 0) continue;
          const childWsId = String(child.publishedfileid);
          if (!configuredWsIds.has(childWsId)) {
            allDeps.push({
              parentWorkshopId: parentWsId,
              parentName,
              childWorkshopId: childWsId,
              childName: null, // resolved in next batch
              source: "steam",
            });
          }
        }
      }
    } catch (e) {
      steamApiFailed = true;
      log.debug?.(`Steam deps batch failed (non-fatal): ${e.message}`);
    }
  }

  if (steamApiFailed) {
    steamWarnings.push(
      "Steam Workshop API was unreachable — dependency check may be incomplete",
    );
  }

  const childIds = [...new Set(allDeps.map((d) => d.childWorkshopId))];
  if (childIds.length > 0) {
    for (let i = 0; i < childIds.length; i += 50) {
      const batch = childIds.slice(i, i + 50);
      const params = new URLSearchParams({ key: steamApiKey });
      batch.forEach((id, idx) => params.append(`publishedfileids[${idx}]`, id));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(
          `https://api.steampowered.com/IPublishedFileService/GetDetails/v1/?${params}`,
          {
            signal: controller.signal,
          },
        );
        clearTimeout(timeout);
        if (!response.ok) continue;
        const data = await response.json();
        const details = data.response?.publishedfiledetails || [];
        const nameMap = new Map();
        for (const item of details) {
          if (item.publishedfileid && item.title) {
            nameMap.set(String(item.publishedfileid), item.title);
          }
        }
        for (const dep of allDeps) {
          if (!dep.childName && nameMap.has(dep.childWorkshopId)) {
            dep.childName = nameMap.get(dep.childWorkshopId);
          }
        }
      } catch (e) {
        log.debug(
          `Steam deps batch name lookup failed (non-fatal): ${e.message}`,
        );
      }
    }
  }

  for (const dep of allDeps) {
    if (!dep.childName) dep.childName = `Workshop Item #${dep.childWorkshopId}`;
  }

  const seen = new Set();
  const deps = allDeps.filter((d) => {
    const key = `${d.parentWorkshopId}-${d.childWorkshopId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { deps, warnings: steamWarnings };
}

router.get("/conflicts/cached", async (req, res) => {
  if (!lastScanResult || Date.now() - lastScanTimestamp > SCAN_CACHE_TTL_MS) {
    return res.json(null);
  }
  try {
    const { workshopIds, modIdsFromIni } = await readIniModLists();
    const currentServerPath = await getServerPath();
    const currentSnapshot = createConflictScanSnapshots(
      workshopIds,
      modIdsFromIni,
    );
    const stale =
      currentSnapshot.workshop !== lastScanWorkshopSnapshot ||
      currentSnapshot.mods !== lastScanModSnapshot ||
      currentServerPath !== lastScanServerPath;
    res.json({
      ...lastScanResult,
      stale,
      _workshopIdsSnapshot: lastScanWorkshopSnapshot
        ? lastScanWorkshopSnapshot.split(",")
        : [],
      _modIdsSnapshot: lastScanModSnapshot
        ? lastScanModSnapshot.split(",")
        : [],
    });
  } catch (e) {
    log.debug(`Error checking scan staleness (marking stale): ${e.message}`);
    res.json({ ...lastScanResult, stale: true });
  }
});

router.get("/conflicts", async (req, res) => {
  const lockToken = acquireScanLock();
  if (!lockToken) {
    return res
      .status(429)
      .json({
        error: "A conflict scan is already running. Please wait.",
        code: ErrorCode.MODS_CONFLICT_SCAN_ALREADY_RUNNING,
      });
  }
  const scanStart = Date.now();
  try {
    const serverPath = await getServerPath();
    if (!serverPath)
      return res.status(400).json({
        error: "Server install path not set — configure it in Settings",
        code: ErrorCode.MODS_SERVER_INSTALL_PATH_NOT_SET,
      });
    const { workshopIds, modIdsFromIni } = await readIniModLists();
    if (workshopIds.length === 0) {
      return res.json({
        totalConflicts: 0,
        identicalSkipped: 0,
        additiveSkipped: 0,
        pzAdditiveSkipped: 0,
        pzAdditiveBreakdown: {
          sandbox: 0,
          scripts: 0,
          clothing: 0,
          fileguidtable: 0,
          translate: 0,
        },
        pairs: [],
        totalPairs: 0,
        modsScanned: 0,
        missingDeps: [],
        modLoadOrder: modIdsFromIni,
        truncated: false,
        warnings: [],
        scanDurationMs: Date.now() - scanStart,
      });
    }
    const {
      fileIndex,
      modInfoMap,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      truncated,
      warnings,
    } = await buildFileIndex(workshopIds, serverPath, null, modIdsFromIni);
    const {
      conflicts,
      identicalSkipped,
      additiveSkipped,
      pzAdditiveSkipped,
      pzAdditiveBreakdown,
    } = await detectConflicts(fileIndex);
    const crossFileConflicts = await detectSameWorkshopLuaSymbolConflicts(
      fileIndex,
      conflicts,
    );
    if (crossFileConflicts.length > 0) conflicts.push(...crossFileConflicts);
    annotateWinners(conflicts, modIdsFromIni);
    const idCollisions = findIdCollisions(modInfoMap, modIdsFromIni);
    const severityOrder = { high: 0, medium: 1, low: 2 };
    conflicts.sort(
      (a, b) =>
        (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3) ||
        a.file.localeCompare(b.file),
    );
    const { pairs, truncated: pairOutputTruncated } =
      groupIntoPairs(conflicts);
    if (pairOutputTruncated) {
      warnings.push(
        `Conflict output reached the global ${CONFLICT_PAIR_FILE_MAX_ENTRIES.toLocaleString()} pair-file limit — the conflict scan is incomplete. Scan fewer mods at once or remove unused ones and retry.`,
      );
    }
    const missingDeps = findMissingDeps(modInfoMap, modIdsFromIni, serverPath);
    let steamDeps = [];
    try {
      const steamResult = await findSteamDeps(workshopIds);
      steamDeps = steamResult.deps;
      warnings.push(...steamResult.warnings);
    } catch (e) {
      log.debug(
        `Steam deps lookup failed during batch scan (non-fatal): ${e.message}`,
      );
    }
    const result = {
      totalConflicts: conflicts.length,
      identicalSkipped,
      additiveSkipped,
      pzAdditiveSkipped,
      pzAdditiveBreakdown,
      pairs,
      totalPairs: pairs.length,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      totalWorkshopIds: workshopIds.length,
      missingDeps,
      steamDeps,
      idCollisions,
      modLoadOrder: modIdsFromIni,
      truncated: truncated || pairOutputTruncated,
      warnings,
      scanDurationMs: Date.now() - scanStart,
    };
    const snapshots = createConflictScanSnapshots(workshopIds, modIdsFromIni);
    lastScanWorkshopSnapshot = snapshots.workshop;
    lastScanModSnapshot = snapshots.mods;
    lastScanServerPath = serverPath;
    lastScanResult = result;
    lastScanTimestamp = Date.now();
    res.json(result);
  } catch (error) {
    log.error(`Failed to scan mod conflicts: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    resetScanCaches();
    releaseScanLock(lockToken);
  }
});

router.get("/conflicts/stream", async (req, res) => {
  const lockToken = acquireScanLock();
  if (!lockToken) {
    return res
      .status(429)
      .json({
        error: "A conflict scan is already running. Please wait.",
        code: ErrorCode.MODS_CONFLICT_SCAN_ALREADY_RUNNING,
      });
  }
  const scanStart = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering if proxied
  });
  res.flushHeaders();

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  const send = (event, data) => {
    if (!res.writable || aborted) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      log.debug(`SSE write failed (stream closed): ${e.message}`);
    }
  };

  const heartbeat = setInterval(() => {
    if (!res.writable || aborted) return;
    try {
      res.write(": ping\n\n");
    } catch (e) {
      log.debug(`SSE heartbeat failed (stream closed): ${e.message}`);
    }
  }, 20_000);
  heartbeat.unref?.();

  try {
    const serverPath = await getServerPath();
    if (!serverPath) {
      send("error", {
        error: "Server install path not set — configure it in Settings",
        code: ErrorCode.MODS_SERVER_INSTALL_PATH_NOT_SET,
      });
      res.end();
      return;
    }
    const { workshopIds, modIdsFromIni } = await readIniModLists();

    send("init", {
      totalWorkshopIds: workshopIds.length,
      modLoadOrder: modIdsFromIni,
    });

    if (workshopIds.length === 0) {
      send("complete", {
        totalConflicts: 0,
        identicalSkipped: 0,
        additiveSkipped: 0,
        pzAdditiveSkipped: 0,
        pzAdditiveBreakdown: {
          sandbox: 0,
          scripts: 0,
          clothing: 0,
          fileguidtable: 0,
          translate: 0,
        },
        pairs: [],
        totalPairs: 0,
        modsScanned: 0,
        totalWorkshopIds: 0,
        missingDeps: [],
        modLoadOrder: modIdsFromIni,
        truncated: false,
        warnings: [],
        scanDurationMs: Date.now() - scanStart,
      });
      res.end();
      return;
    }

    const {
      fileIndex,
      modInfoMap,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      truncated,
      warnings,
    } = await buildFileIndex(
      workshopIds,
      serverPath,
      (info) => {
        if (aborted) return;
        send("mod-scanned", {
          modId: info.modId,
          modName: info.modName,
          workshopId: info.workshopId,
          fileCount: info.fileCount,
          modsScanned: info.modsScanned,
          totalWorkshopIds: info.totalWorkshopIds,
          progress: Math.round(((info.wsIdx + 1) / info.totalWorkshopIds) * 60), // 0-60%
        });
      },
      modIdsFromIni,
    );

    if (aborted) {
      res.end();
      return;
    }
    send("phase", { phase: "hashing", progress: 60 });

    let conflictCount = 0;
    const {
      conflicts,
      identicalSkipped,
      additiveSkipped,
      pzAdditiveSkipped,
      pzAdditiveBreakdown,
    } = await detectConflicts(
      fileIndex,
      (conflict) => {
        if (aborted) return;
        conflictCount++;
        if (
          conflict.severity === "high" ||
          conflictCount <= 5 ||
          conflictCount % 3 === 0
        ) {
          send("conflict-found", {
            file: conflict.file,
            severity: conflict.severity,
            categoryLabel: conflict.categoryLabel,
            mods: conflict.mods.map((m) => m.modName),
            conflictsSoFar: conflictCount,
          });
        }
      },
      {
        shouldAbort: () => aborted,
        onProgress: ({ processed, total }) => {
          if (aborted || total === 0) return;
          send("phase", {
            phase: "hashing",
            progress: 60 + Math.round((processed / total) * 25),
          });
        },
      },
    );

    if (aborted) {
      res.end();
      return;
    }
    send("phase", { phase: "grouping", progress: 85 });

    const crossFileConflicts = await detectSameWorkshopLuaSymbolConflicts(
      fileIndex,
      conflicts,
      (conflict) => {
        if (aborted) return;
        conflictCount++;
        send("conflict-found", {
          file: conflict.file,
          severity: conflict.severity,
          categoryLabel: conflict.categoryLabel,
          mods: conflict.mods.map((m) => m.modName),
          conflictsSoFar: conflictCount,
        });
      },
      { shouldAbort: () => aborted },
    );
    if (crossFileConflicts.length > 0) conflicts.push(...crossFileConflicts);

    annotateWinners(conflicts, modIdsFromIni);
    const idCollisions = findIdCollisions(modInfoMap, modIdsFromIni);
    const severityOrder = { high: 0, medium: 1, low: 2 };
    conflicts.sort(
      (a, b) =>
        (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3) ||
        a.file.localeCompare(b.file),
    );
    const { pairs, truncated: pairOutputTruncated } =
      groupIntoPairs(conflicts);
    if (pairOutputTruncated) {
      warnings.push(
        `Conflict output reached the global ${CONFLICT_PAIR_FILE_MAX_ENTRIES.toLocaleString()} pair-file limit — the conflict scan is incomplete. Scan fewer mods at once or remove unused ones and retry.`,
      );
    }
    const missingDeps = findMissingDeps(modInfoMap, modIdsFromIni, serverPath);

    let steamDeps = [];
    try {
      if (!aborted) {
        send("phase", { phase: "dependencies", progress: 90 });
        const steamResult = await findSteamDeps(workshopIds);
        steamDeps = steamResult.deps;
        warnings.push(...steamResult.warnings);
      }
    } catch (e) {
      log.debug(
        `Steam deps lookup failed during SSE scan (non-fatal): ${e.message}`,
      );
    }

    const result = {
      totalConflicts: conflicts.length,
      identicalSkipped,
      additiveSkipped,
      pzAdditiveSkipped,
      pzAdditiveBreakdown,
      pairs,
      totalPairs: pairs.length,
      modsScanned,
      modsNotFound,
      modsSkippedInactive,
      totalWorkshopIds: workshopIds.length,
      missingDeps,
      steamDeps,
      idCollisions,
      modLoadOrder: modIdsFromIni,
      truncated: truncated || pairOutputTruncated,
      warnings,
      scanDurationMs: Date.now() - scanStart,
    };
    lastScanResult = result;
    lastScanTimestamp = Date.now();
    const snapshots = createConflictScanSnapshots(workshopIds, modIdsFromIni);
    lastScanWorkshopSnapshot = snapshots.workshop;
    lastScanModSnapshot = snapshots.mods;
    lastScanServerPath = serverPath;
    send("complete", result);
    res.end();
  } catch (error) {
    log.error(`Streaming conflict scan failed: ${error.message}`);
    if (!aborted) {
      send("error", { error: sanitizeError(error.message) });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    resetScanCaches();
    releaseScanLock(lockToken);
  }
});

const DIFF_MAX_BYTES = 512 * 1024;

router.get("/conflicts/diff", async (req, res) => {
  try {
    const { file, modA, modB } = req.query;
    if (!file || !modA || !modB) {
      return res.status(400).json({
        error:
          "Could not load file comparison — missing file or mod information",
        code: ErrorCode.MODS_CONFLICTS_DIFF_PARAMS_REQUIRED,
      });
    }

    const modAStr = String(modA);
    const modBStr = String(modB);
    if (
      !/^[\w .\-]{1,200}$/.test(modAStr) ||
      !/^[\w .\-]{1,200}$/.test(modBStr)
    ) {
      return res
        .status(400)
        .json({
          error: "Could not identify one of the mods — try rescanning",
          code: ErrorCode.MODS_CONFLICTS_DIFF_MOD_ID_INVALID,
        });
    }

    const normalizedFile = String(file).replace(/\\/g, "/");
    if (
      normalizedFile.includes("..") ||
      path.isAbsolute(normalizedFile) ||
      normalizedFile.length > 500
    ) {
      return res.status(400).json({
        error: "The file path looks invalid — try rescanning conflicts",
        code: ErrorCode.MODS_CONFLICTS_DIFF_PATH_INVALID,
      });
    }

    const serverPath = await getServerPath();
    if (!serverPath)
      return res.status(400).json({
        error: "Server install path not set — configure it in Settings",
        code: ErrorCode.MODS_SERVER_INSTALL_PATH_NOT_SET,
      });
    const { workshopIds } = await readIniModLists();

    let pathA = null,
      pathB = null;
    for (const wsId of workshopIds) {
      if (!/^\d{1,15}$/.test(wsId)) continue;
      const possiblePaths = getWorkshopPaths(wsId, serverPath);
      let workshopPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          workshopPath = p;
          break;
        }
      }
      if (!workshopPath) continue;

      const modDetails = getModDetailsFromWorkshop(wsId, serverPath);
      const modsFolder = path.join(workshopPath, "mods");
      const searchBase = fs.existsSync(modsFolder) ? modsFolder : workshopPath;
      let modEntries;
      try {
        modEntries = fs.readdirSync(searchBase, { withFileTypes: true });
      } catch (e) {
        log.debug(`Could not read mod directory ${searchBase}: ${e.message}`);
        continue;
      }

      for (const modDir of modEntries) {
        if (!modDir.isDirectory()) continue;
        const matchingMod = modDetails.find(
          (m) => m.id === modDir.name || m.name === modDir.name,
        );
        const modId = matchingMod?.id || modDir.name;
        const modDirPath = path.join(searchBase, modDir.name);

        const mediaCandidates = [path.join(modDirPath, "media")];
        if (!fs.existsSync(mediaCandidates[0])) {
          mediaCandidates.length = 0;
          try {
            const subDirs = fs.readdirSync(modDirPath, { withFileTypes: true });
            for (const sub of subDirs) {
              if (
                sub.isDirectory() &&
                /^(42(\.\d+)?|common)$/i.test(sub.name)
              ) {
                mediaCandidates.push(path.join(modDirPath, sub.name, "media"));
              }
            }
          } catch (e) {
            /* skip unreadable */
          }
        }

        for (const mediaDir of mediaCandidates) {
          const candidate = path.join(mediaDir, normalizedFile);
          const resolved = path.resolve(candidate);
          const mediaBase = path.resolve(mediaDir);
          if (
            !resolved.startsWith(mediaBase + path.sep) &&
            resolved !== mediaBase
          )
            continue;
          if (modId === String(modA) && fs.existsSync(candidate))
            pathA = candidate;
          if (modId === String(modB) && fs.existsSync(candidate))
            pathB = candidate;
        }
      }
      if (pathA && pathB) break;
    }

    if (!pathA || !pathB) {
      return res.status(404).json({
        error:
          "Could not find both mod files on disk — they may have been removed or updated since the last scan",
        code: ErrorCode.MODS_CONFLICTS_DIFF_FILES_NOT_FOUND,
      });
    }

    const ext = path.extname(normalizedFile).toLowerCase();
    const textExts = new Set([
      ".lua",
      ".txt",
      ".xml",
      ".json",
      ".cfg",
      ".ini",
      ".csv",
      ".md",
      ".properties",
      ".script",
    ]);
    const imageExts = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".tga",
    ]);
    const isText = textExts.has(ext);
    const isImage = imageExts.has(ext);

    if (isImage) {
      const statA = fs.statSync(pathA);
      const statB = fs.statSync(pathB);
      const maxImg = 2 * 1024 * 1024;
      return res.json({
        type: "image",
        ext,
        modA: {
          size: statA.size,
          base64:
            statA.size <= maxImg
              ? fs.readFileSync(pathA).toString("base64")
              : null,
        },
        modB: {
          size: statB.size,
          base64:
            statB.size <= maxImg
              ? fs.readFileSync(pathB).toString("base64")
              : null,
        },
      });
    }

    if (!isText) {
      const statA = fs.statSync(pathA);
      const statB = fs.statSync(pathB);
      return res.json({
        type: "binary",
        ext,
        modA: { size: statA.size, hash: hashFileSync(pathA) },
        modB: { size: statB.size, hash: hashFileSync(pathB) },
      });
    }

    const statA = fs.statSync(pathA);
    const statB = fs.statSync(pathB);
    if (statA.size > DIFF_MAX_BYTES || statB.size > DIFF_MAX_BYTES) {
      return res.json({
        type: "text-too-large",
        ext,
        modA: { size: statA.size, hash: hashFileSync(pathA) },
        modB: { size: statB.size, hash: hashFileSync(pathB) },
      });
    }

    const contentA = fs.readFileSync(pathA, "utf-8");
    const contentB = fs.readFileSync(pathB, "utf-8");
    const linesA = contentA.split("\n");
    const linesB = contentB.split("\n");

    const hunks = computeUnifiedDiff(linesA, linesB, 3);

    res.json({
      type: "text",
      ext,
      modA: { size: statA.size, lineCount: linesA.length },
      modB: { size: statB.size, lineCount: linesB.length },
      hunks,
      totalAdded: hunks.reduce(
        (s, h) => s + h.lines.filter((l) => l.type === "add").length,
        0,
      ),
      totalRemoved: hunks.reduce(
        (s, h) => s + h.lines.filter((l) => l.type === "remove").length,
        0,
      ),
    });
  } catch (error) {
    log.error(`Failed to diff files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

function computeUnifiedDiff(linesA, linesB, contextLines = 3) {
  const n = linesA.length,
    m = linesB.length;

  if (n > 65535 || m > 65535 || n * m > 10_000_000) {
    return [
      {
        startA: 1,
        startB: 1,
        countA: n,
        countB: m,
        lines: [
          ...linesA
            .slice(0, 50)
            .map((l, i) => ({ type: "remove", lineA: i + 1, text: l })),
          {
            type: "context",
            text: `... (${n} lines in Mod A, ${m} lines in Mod B — file too large for inline diff)`,
          },
          ...linesB
            .slice(0, 50)
            .map((l, i) => ({ type: "add", lineB: i + 1, text: l })),
        ],
      },
    ];
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        linesA[i - 1] === linesB[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.push({ type: "equal", lineA: i, lineB: j, text: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", lineB: j, text: linesB[j - 1] });
      j--;
    } else {
      ops.push({ type: "remove", lineA: i, text: linesA[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const hunks = [];
  let currentHunk = null;
  let sinceLastChange = Infinity;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const isChange = op.type !== "equal";

    if (isChange) {
      if (!currentHunk || sinceLastChange > contextLines * 2) {
        if (currentHunk) hunks.push(currentHunk);
        const ctxStart = Math.max(0, k - contextLines);
        currentHunk = {
          startA: ops[ctxStart]?.lineA || op.lineA || 1,
          startB: ops[ctxStart]?.lineB || op.lineB || 1,
          lines: [],
        };
        for (let c = ctxStart; c < k; c++) {
          if (ops[c].type === "equal") {
            currentHunk.lines.push({
              type: "context",
              lineA: ops[c].lineA,
              lineB: ops[c].lineB,
              text: ops[c].text,
            });
          }
        }
      }
      currentHunk.lines.push(op);
      sinceLastChange = 0;
    } else {
      sinceLastChange++;
      if (currentHunk && sinceLastChange <= contextLines) {
        currentHunk.lines.push({
          type: "context",
          lineA: op.lineA,
          lineB: op.lineB,
          text: op.text,
        });
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  for (const hunk of hunks) {
    hunk.countA = hunk.lines.filter((l) => l.type !== "add").length;
    hunk.countB = hunk.lines.filter((l) => l.type !== "remove").length;
  }

  return hunks;
}

router.get("/disk-only", async (req, res) => {
  try {
    const modChecker = req.app.get("modChecker");
    if (!modChecker || !modChecker.workshopAcfPath) {
      return res.json({ mods: [], reason: "workshop folder not configured" });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const inIni = new Set();
    if (serverConfigPath && serverName) {
      const sanitized = path.basename(serverName);
      if (sanitized === serverName && !serverName.includes("..")) {
        const iniPath = path.join(serverConfigPath, `${sanitized}.ini`);
        if (fs.existsSync(iniPath)) {
          const content = readTextFile(iniPath);
          const m = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
          for (const id of m?.[1]?.split(";").filter(Boolean) || [])
            inIni.add(id);
        }
      }
    }

    const ignored = new Set();
    try {
      for (const m of (await getIgnoredMods()) || []) {
        if (m?.workshop_id) ignored.add(String(m.workshop_id));
      }
    } catch {
      /* best-effort */
    }

    const workshopDir = path.dirname(modChecker.workshopAcfPath);
    const contentDir = path.join(workshopDir, "content", "108600");
    if (!fs.existsSync(contentDir)) {
      return res.json({ mods: [], reason: "no workshop content folder" });
    }

    let entries = [];
    try {
      entries = fs.readdirSync(contentDir, { withFileTypes: true });
    } catch (e) {
      log.warn(`disk-only: failed to read ${contentDir}: ${e.message}`);
      return res.json({ mods: [], reason: "cannot read workshop folder" });
    }

    const mods = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsId = entry.name;
      if (!/^\d{1,15}$/.test(wsId)) continue;
      if (inIni.has(wsId)) continue;
      if (ignored.has(wsId)) continue;
      const name =
        modChecker.resolveModNameFromDisk(wsId) || `Workshop Mod ${wsId}`;
      mods.push({ workshop_id: wsId, name });
    }

    res.json({ mods });
  } catch (error) {
    log.error(`Failed to list disk-only mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/enable-disk-mod", async (req, res) => {
  try {
    const { workshopId } = req.body || {};
    const wsId = String(workshopId || "");
    if (!/^\d{1,15}$/.test(wsId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }
    const sanitized = path.basename(serverName);
    if (sanitized !== serverName || serverName.includes("..")) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitized}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(404).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    const modIdsToAdd = serverPath
      ? findAllModIdsFromWorkshop(wsId, serverPath)
      : [];

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      const wsList = wsMatch?.[1]?.split(";").filter(Boolean) || [];
      if (!wsList.includes(wsId)) wsList.push(wsId);
      const wsLine = `WorkshopItems=${sanitizeIniList(wsList)}`;
      content = wsMatch
        ? content.replace(/^[ \t]*WorkshopItems[ \t]*=.*/m, wsLine)
        : content.trimEnd() + `\n${wsLine}\n`;

      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      const existing = modsMatch?.[1]?.split(";").filter(Boolean) || [];
      const cleanedExisting = sanitizeModIdList(existing)
        .split(";")
        .filter(Boolean);
      const modsList = [...cleanedExisting];
      for (const mid of modIdsToAdd) {
        if (!modsList.includes(mid)) modsList.push(mid);
      }
      const modsLine = `Mods=${sanitizeIniList(modsList)}`;
      content = modsMatch
        ? content.replace(/^[ \t]*Mods[ \t]*=.*/m, modsLine)
        : content.trimEnd() + `\n${modsLine}\n`;

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    try {
      await removeIgnoredMod(wsId);
    } catch {
      /* best-effort */
    }

    log.info(
      `Enabled disk-only mod ${wsId} (added ${modIdsToAdd.length} mod IDs)`,
    );
    res.json({
      success: true,
      workshopId: wsId,
      modIdsAdded: modIdsToAdd.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to enable disk-only mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

async function deleteModFromDiskAndIni(wsId) {
  const serverConfigPath = await getServerConfigPath();
  const serverName = await getServerName();
  const serverPath = await getServerPath();
  const sanitized = serverName ? path.basename(serverName) : null;
  const iniPath =
    sanitized && serverConfigPath
      ? path.join(serverConfigPath, `${sanitized}.ini`)
      : null;

  if (!iniPath || !fs.existsSync(iniPath)) {
    return {
      removedPath: null,
      modIdsToStrip: [],
      mapFoldersToStrip: [],
      iniEditApplied: false,
      error: "Server config file was not found or not accessible",
    };
  }

  const modIdsToStrip = serverPath
    ? findAllModIdsFromWorkshop(wsId, serverPath)
    : [];
  const mapFoldersToStrip = serverPath
    ? findMapFoldersFromWorkshop(wsId, serverPath)
    : [];

  let backupWarning = null;
  await withIniLock(iniPath, async () => {
    let content = readTextFile(iniPath);
    const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
    if (wsMatch) {
      const wsList = wsMatch[1]
        .split(";")
        .filter(Boolean)
        .filter((id) => id !== wsId);
      content = content.replace(
        /^[ \t]*WorkshopItems[ \t]*=.*/m,
        `WorkshopItems=${sanitizeIniList(wsList)}`,
      );
    }
    const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
    if (modsMatch && modIdsToStrip.length > 0) {
      const modsList = modsMatch[1]
        .split(";")
        .filter(Boolean)
        .filter((id) => !modIdsToStrip.includes(id));
      content = content.replace(
        /^[ \t]*Mods[ \t]*=.*/m,
        `Mods=${sanitizeModIdList(modsList)}`,
      );
    }
    const mapMatch = content.match(/^[ \t]*Map[ \t]*=[ \t]*(.*)$/m);
    if (mapMatch && mapFoldersToStrip.length > 0) {
      let mapList = mapMatch[1]
        .split(";")
        .filter(Boolean)
        .filter((m) => !mapFoldersToStrip.includes(m));
      if (mapList.length === 0) mapList = ["Muldraugh, KY"];
      content = content.replace(
        /^[ \t]*Map[ \t]*=.*/m,
        `Map=${sanitizeIniList(mapList)}`,
      );
    }
    backupWarning = backupWarningFor(
      await writeIniWithBackup(iniPath, content),
    );
  });

  const possiblePaths = getWorkshopPaths(wsId, serverPath || "");
  let removedPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
        removedPath = p;
        break;
      } catch (e) {
        log.warn(`Failed to delete workshop folder ${p}: ${e.message}`);
      }
    }
  }

  return {
    removedPath,
    modIdsToStrip,
    mapFoldersToStrip,
    iniEditApplied: true,
    backupWarning,
  };
}

router.post("/delete-disk-mod", async (req, res) => {
  try {
    const { workshopId } = req.body || {};
    const wsId = String(workshopId || "");
    if (!/^\d{1,15}$/.test(wsId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    const { removedPath, modIdsToStrip, iniEditApplied, backupWarning } =
      await deleteModFromDiskAndIni(wsId);

    if (!iniEditApplied) {
      return res.status(400).json({
        error: "Server config file was not found or not accessible",
        code: ErrorCode.MODS_INI_NOT_ACCESSIBLE,
        workshopId: wsId,
        deletedFromDisk: false,
      });
    }

    let priorName = null;
    try {
      const tracked = await getTrackedMods();
      priorName =
        tracked?.find((m) => String(m.workshop_id) === wsId)?.name || null;
    } catch {
      /* ignore */
    }
    if (!priorName && req.body?.modName)
      priorName = String(req.body.modName).slice(0, 200);
    if (iniEditApplied) {
      try {
        await removeTrackedMod(wsId);
      } catch {
        /* ignore */
      }
      try {
        await addIgnoredMod(wsId, priorName);
      } catch {
        /* ignore */
      }
    } else {
      log.error(
        `delete-disk-mod ${wsId}: INI edit was never applied (missing server config path or ini file) — not ignore-listing`,
      );
    }

    log.info(
      `Deleted disk mod ${wsId} (folder: ${removedPath || "not found"}, mod IDs stripped: ${modIdsToStrip.length})`,
    );
    res.json({
      success: true,
      workshopId: wsId,
      deletedFromDisk: !!removedPath,
      modIdsStripped: modIdsToStrip.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to delete disk mod: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/purge", async (req, res) => {
  try {
    const wsId = String(req.body?.workshopId || "").trim();
    if (!/^\d{1,15}$/.test(wsId)) {
      return res.status(400).json({
        error: "Invalid workshop ID",
        code: ErrorCode.MODS_INVALID_WORKSHOP_ID_LOWER,
      });
    }

    let name = null;
    try {
      const tracked = await getTrackedMods();
      name = tracked?.find((m) => String(m.workshop_id) === wsId)?.name || null;
    } catch {
      /* ignore */
    }
    if (!name && req.body?.name) name = String(req.body.name).slice(0, 200);

    const collection = { attempted: false, ok: false, error: null };
    const collectionId = await getSetting("workshopCollectionId");
    if (collectionId) {
      collection.attempted = true;
      try {
        const r = await removeItemFromCollection(collectionId, wsId);
        collection.ok = !!r.ok;
        if (!r.ok) collection.error = r.error || "Steam rejected the change";
      } catch (e) {
        collection.error = e.message;
      }
    }

    const {
      removedPath,
      modIdsToStrip,
      mapFoldersToStrip,
      iniEditApplied,
      backupWarning,
    } = await deleteModFromDiskAndIni(wsId);

    if (!iniEditApplied) {
      log.error(
        `Purge ${wsId}: INI edit was never applied (missing server config path or ini file) — not untracking or ignore-listing`,
      );
      return res.status(500).json({
        error:
          "Server config file was not found or not accessible — the mod was not removed from the server.",
        code: ErrorCode.MODS_PURGE_INI_NOT_ACCESSIBLE,
        collection,
        deletedFromDisk: !!removedPath,
      });
    }

    try {
      await removeTrackedMod(wsId);
    } catch {
      /* ignore */
    }
    try {
      await addIgnoredMod(wsId, name);
    } catch {
      /* ignore */
    }

    log.info(
      `Purged ${wsId} (${name || "unknown name"}): collection=${
        collection.attempted ? (collection.ok ? "removed" : "failed") : "skipped"
      }, disk=${removedPath || "not found"}, mod IDs stripped=${
        modIdsToStrip.length
      }, map folders stripped=${mapFoldersToStrip.length}`,
    );

    res.json({
      success: true,
      workshopId: wsId,
      name,
      collection,
      deletedFromDisk: !!removedPath,
      modIdsStripped: modIdsToStrip.length,
      mapFoldersStripped: mapFoldersToStrip.length,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Purge failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/batch-delete-disk-mods", async (req, res) => {
  try {
    const { workshopIds } = req.body || {};
    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res
        .status(400)
        .json({
          error: "workshopIds must be a non-empty array",
          code: ErrorCode.MODS_WORKSHOP_IDS_ARRAY_REQUIRED,
        });
    }
    const cleaned = workshopIds
      .map(String)
      .filter((id) => /^\d{1,15}$/.test(id));
    if (cleaned.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    const sanitized = serverName ? path.basename(serverName) : null;
    const iniPath =
      sanitized && serverConfigPath
        ? path.join(serverConfigPath, `${sanitized}.ini`)
        : null;

    if (!iniPath || !fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: "Server config file was not found or not accessible",
        code: ErrorCode.MODS_INI_NOT_ACCESSIBLE,
      });
    }

    const allModIdsToStrip = new Set();
    for (const wsId of cleaned) {
      if (serverPath) {
        for (const m of findAllModIdsFromWorkshop(wsId, serverPath))
          allModIdsToStrip.add(m);
      }
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);
      const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
      if (wsMatch) {
        const wsList = wsMatch[1]
          .split(";")
          .filter(Boolean)
          .filter((id) => !cleaned.includes(id));
        content = content.replace(
          /^[ \t]*WorkshopItems[ \t]*=.*/m,
          `WorkshopItems=${sanitizeIniList(wsList)}`,
        );
      }
      const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
      if (modsMatch && allModIdsToStrip.size > 0) {
        const modsList = modsMatch[1]
          .split(";")
          .filter(Boolean)
          .filter((id) => !allModIdsToStrip.has(id));
        content = content.replace(
          /^[ \t]*Mods[ \t]*=.*/m,
          `Mods=${sanitizeModIdList(modsList)}`,
        );
      }
      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    const results = [];
    for (const wsId of cleaned) {
      const possiblePaths = getWorkshopPaths(wsId, serverPath || "");
      let removed = false;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
            removed = true;
            break;
          } catch (e) {
            log.warn(`Failed to delete ${p}: ${e.message}`);
          }
        }
      }
      results.push({ workshopId: wsId, deletedFromDisk: removed });
    }

    let trackedById = new Map();
    try {
      for (const m of (await getTrackedMods()) || []) {
        if (m?.workshop_id)
          trackedById.set(String(m.workshop_id), m.name || null);
      }
    } catch {
      /* ignore */
    }
    for (const wsId of cleaned) {
      try {
        await removeTrackedMod(wsId);
      } catch {
        /* ignore */
      }
      try {
        await addIgnoredMod(wsId, trackedById.get(wsId) || null);
      } catch {
        /* ignore */
      }
    }

    const deletedCount = results.filter((r) => r.deletedFromDisk).length;
    log.info(
      `Batch deleted ${deletedCount}/${cleaned.length} disk mods (mod IDs stripped: ${allModIdsToStrip.size})`,
    );
    res.json({
      success: true,
      total: cleaned.length,
      deletedFromDisk: deletedCount,
      modIdsStripped: allModIdsToStrip.size,
      results,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to batch delete disk mods: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/resolve-orphan-workshop", async (req, res) => {
  try {
    const { workshopIds } = req.body || {};
    if (!Array.isArray(workshopIds) || workshopIds.length === 0) {
      return res
        .status(400)
        .json({
          error: "workshopIds must be a non-empty array",
          code: ErrorCode.MODS_WORKSHOP_IDS_ARRAY_REQUIRED,
        });
    }
    const cleaned = workshopIds
      .map(String)
      .filter((id) => /^\d{1,15}$/.test(id));
    if (cleaned.length === 0) {
      return res.status(400).json({
        error: "No valid workshop IDs provided",
        code: ErrorCode.MODS_NO_VALID_WORKSHOP_IDS,
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();
    const serverPath = await getServerPath();
    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set",
        code: ErrorCode.MODS_CONFIG_PATH_NOT_SET,
      });
    }
    const sanitized = path.basename(serverName);
    if (sanitized !== serverName || serverName.includes("..")) {
      return res.status(400).json({
        error: "Invalid server name",
        code: ErrorCode.MODS_INVALID_SERVER_NAME,
      });
    }
    const iniPath = path.join(serverConfigPath, `${sanitized}.ini`);
    if (!fs.existsSync(iniPath)) {
      return res.status(404).json({
        error: "Server INI not found",
        code: ErrorCode.MODS_SERVER_INI_NOT_FOUND,
      });
    }

    const ignoredSet = new Set();
    try {
      for (const m of (await getIgnoredMods()) || []) {
        if (m?.workshop_id) ignoredSet.add(String(m.workshop_id));
      }
    } catch {
      /* best-effort */
    }

    const wsToDrop = new Set();
    const modIdsToAdd = new Set();
    const breakdown = [];
    for (const wsId of cleaned) {
      const ignored = ignoredSet.has(wsId);
      const folderExists = serverPath
        ? getWorkshopPaths(wsId, serverPath).some((p) => fs.existsSync(p))
        : false;
      let action;
      const ids =
        folderExists && serverPath
          ? findAllModIdsFromWorkshop(wsId, serverPath)
          : [];

      if (ignored) {
        wsToDrop.add(wsId);
        action = "dropped-ignored";
      } else if (!folderExists) {
        wsToDrop.add(wsId);
        action = "dropped-missing";
      } else if (ids.length === 0) {
        wsToDrop.add(wsId);
        action = "dropped-no-mod-info";
      } else {
        for (const m of ids) modIdsToAdd.add(m);
        action = "enabled";
      }
      breakdown.push({ workshopId: wsId, action, modIds: ids });
    }

    let backupWarning = null;
    await withIniLock(iniPath, async () => {
      let content = readTextFile(iniPath);

      if (wsToDrop.size > 0) {
        const wsMatch = content.match(/^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m);
        if (wsMatch) {
          const wsList = wsMatch[1]
            .split(";")
            .filter(Boolean)
            .filter((id) => !wsToDrop.has(id));
          content = content.replace(
            /^[ \t]*WorkshopItems[ \t]*=.*/m,
            `WorkshopItems=${sanitizeIniList(wsList)}`,
          );
        }
      }

      if (modIdsToAdd.size > 0) {
        const modsMatch = content.match(/^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m);
        const existing = modsMatch?.[1]?.split(";").filter(Boolean) || [];
        const cleanedExisting = sanitizeModIdList(existing)
          .split(";")
          .filter(Boolean);
        const finalList = [...cleanedExisting];
        for (const m of modIdsToAdd) {
          if (!finalList.includes(m)) finalList.push(m);
        }
        const newLine = `Mods=${sanitizeIniList(finalList)}`;
        content = modsMatch
          ? content.replace(/^[ \t]*Mods[ \t]*=.*/m, newLine)
          : content.trimEnd() + `\n${newLine}\n`;
      }

      backupWarning = backupWarningFor(
        await writeIniWithBackup(iniPath, content),
      );
    });

    const counts = {
      enabled: breakdown.filter((b) => b.action === "enabled").length,
      droppedIgnored: breakdown.filter((b) => b.action === "dropped-ignored")
        .length,
      droppedMissing: breakdown.filter((b) => b.action === "dropped-missing")
        .length,
      droppedNoModInfo: breakdown.filter(
        (b) => b.action === "dropped-no-mod-info",
      ).length,
    };
    log.info(
      `Resolve-orphan-workshop: enabled=${counts.enabled}, droppedIgnored=${counts.droppedIgnored}, droppedMissing=${counts.droppedMissing}, droppedNoModInfo=${counts.droppedNoModInfo} (modIdsAdded=${modIdsToAdd.size}, wsDropped=${wsToDrop.size})`,
    );
    res.json({
      success: true,
      total: cleaned.length,
      counts,
      modIdsAdded: modIdsToAdd.size,
      wsDropped: wsToDrop.size,
      breakdown,
      ...(backupWarning ? { backupWarning } : {}),
    });
  } catch (error) {
    log.error(`Failed to resolve orphan workshop items: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

const THUMB_FETCH_TIMEOUT_MS = 12_000;
const THUMB_MAX_BYTES = 5 * 1024 * 1024;
const THUMB_INFLIGHT = new Map();
const THUMB_EMPTY_GIF = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);
const THUMB_FAIL_TTL_MS = 5 * 60 * 1000;
const THUMB_FAIL_CACHE = new Map();
let _thumbLastFailure = null;

function recordThumbFailure(wsId, reason) {
  const failedAt = Date.now();
  THUMB_FAIL_CACHE.set(wsId, { failedAt, reason });
  _thumbLastFailure = { workshopId: wsId, reason, at: failedAt };
}

function clearThumbFailure(wsId) {
  THUMB_FAIL_CACHE.delete(wsId);
}

function liveThumbFailure(wsId) {
  const entry = THUMB_FAIL_CACHE.get(wsId);
  if (!entry) return null;
  if (Date.now() - entry.failedAt >= THUMB_FAIL_TTL_MS) {
    THUMB_FAIL_CACHE.delete(wsId);
    return null;
  }
  return entry;
}

export async function getThumbnailResolutionStatus() {
  const now = Date.now();
  let failing = 0;
  for (const [wsId, entry] of [...THUMB_FAIL_CACHE]) {
    if (now - entry.failedAt < THUMB_FAIL_TTL_MS) {
      failing++;
    } else {
      THUMB_FAIL_CACHE.delete(wsId);
    }
  }
  const tracked = await getTrackedMods();
  return { failing, total: tracked.length, lastError: _thumbLastFailure };
}

function sendEmptyThumbnail(res) {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.end(THUMB_EMPTY_GIF);
}

async function fetchSteamPreviewUrl(workshopId) {
  const params = new URLSearchParams();
  params.append("itemcount", "1");
  params.append("publishedfileids[0]", workshopId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
      { method: "POST", body: params, signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.response?.publishedfiledetails?.[0];
    if (item?.result === 1 && typeof item.preview_url === "string") {
      return item.preview_url;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadThumbnail(previewUrl) {
  let parsed;
  try {
    parsed = new URL(previewUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "steamuserimages-a.akamaihd.net" ||
    host.endsWith(".steamstatic.com") ||
    host.endsWith(".akamaihd.net") ||
    host === "images.steamusercontent.com";
  if (!allowed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(previewUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len && len > THUMB_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > THUMB_MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.get("/thumbnail/:workshopId", async (req, res) => {
  const wsId = String(req.params.workshopId || "");
  if (!/^\d{1,15}$/.test(wsId)) {
    return res.status(400).end();
  }

  const dataDir = getDataPaths().dataDir;
  const cacheDir = path.join(dataDir, "mod-thumbnails");
  const cacheFile = path.join(cacheDir, `${wsId}.img`);

  if (!cacheFile.startsWith(cacheDir + path.sep)) {
    return res.status(400).end();
  }

  try {
    const st = await fsp.stat(cacheFile);
    if (st.size > 0) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      return res.sendFile(cacheFile);
    }
  } catch {
    /* not cached yet */
  }

  if (liveThumbFailure(wsId)) {
    return sendEmptyThumbnail(res);
  }

  let pending = THUMB_INFLIGHT.get(wsId);
  if (!pending) {
    pending = (async () => {
      const tracked = await getTrackedMods();
      let mod = tracked.find((m) => m.workshop_id === wsId);
      let previewUrl = mod?.preview_url || null;
      if (!previewUrl) {
        previewUrl = await fetchSteamPreviewUrl(wsId);
        if (previewUrl) {
          try {
            const { setModPreviewUrl } = await import("../database/init.js");
            await setModPreviewUrl(wsId, previewUrl);
          } catch {
            /* best-effort */
          }
        }
      }
      if (!previewUrl) {
        recordThumbFailure(wsId, "no Steam preview URL available");
        return null;
      }
      const buf = await downloadThumbnail(previewUrl);
      if (!buf) {
        recordThumbFailure(wsId, "preview image download failed");
        return null;
      }
      await fsp.mkdir(cacheDir, { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, cacheFile);
      clearThumbFailure(wsId);
      return buf;
    })().finally(() => {
      THUMB_INFLIGHT.delete(wsId);
    });
    THUMB_INFLIGHT.set(wsId, pending);
  }

  try {
    const buf = await pending;
    if (!buf) return sendEmptyThumbnail(res);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.end(buf);
  } catch (err) {
    log.debug(`Thumbnail fetch failed for ${wsId}: ${err.message}`);
    recordThumbFailure(wsId, err.message);
    return sendEmptyThumbnail(res);
  }
});

export default router;


import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import bridge from "../services/panelBridge.js";
import {
  getActiveServer,
  getServer,
  getServers,
  getAllSettings,
  setSetting,
  getDb,
  commitNow,
  logBridgeCommand,
  getRoleByName,
} from "../database/init.js";
import { sanitizeError, sanitizeErrorParams, isMaskedSecret } from "../utils/sanitize.ts";
import { getDataPaths } from "../utils/paths.ts";
import { persistSandboxValues } from "./serverFiles.js";
import { requirePermission } from "../services/permissions.js";
import { parseClampedInteger } from "../utils/queryNumbers.ts";
import {
  getEmbeddedPanelBridgeLua,
  compareModVersions,
  writeLuaAtomic,
} from "../utils/embeddedLua.ts";
import {
  canAutoInstall,
  checkBridgeInstalled,
  getBundledBridgeVersion,
  installBridge,
  isBridgeVersionBehindBundled,
  resolveInstallDir,
} from "../services/panelBridgeInstaller.ts";
import { createLogger } from "../utils/logger.ts";
import {
  getSftpCachePath,
  testSftpBridge,
  formatSftpError,
  classifySftpErrorCode,
  validateSftpBridgeConfig,
  listSftpLogs,
  readSftpLogTail,
} from "../services/panelBridgeSftp.ts";
import {
  SFTP_CONFIG_PATH_KEY,
  listRemoteConfigFiles,
  resetRemoteConfigSession,
  validateRemoteConfigTransport,
} from "../services/remoteConfigFiles.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
const log = createLogger("API:PanelBridge");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const ITEM_TYPE_REGEX = /^[A-Za-z0-9_]+\.[A-Za-z0-9_&#+.\-]+$/;
const VEHICLE_SCRIPT_REGEX = /^[A-Za-z0-9_]+\.[A-Za-z0-9_&#+.\-]+$/;

const SFTP_SETTING_KEYS = {
  enabled: "panelBridgeSftpEnabled",
  host: "panelBridgeSftpHost",
  port: "panelBridgeSftpPort",
  username: "panelBridgeSftpUsername",
  password: "panelBridgeSftpPassword",
  bridgePath: "panelBridgeSftpBridgePath",
  pollIntervalSeconds: "panelBridgeSftpPollIntervalSeconds",
};

const SFTP_LOG_PATH_KEY = "panelBridgeSftpLogPath";

async function resolveSftpConfig(input = {}) {
  const settings = await getAllSettings();
  const password = input.password && !isMaskedSecret(input.password)
    ? input.password
    : settings[SFTP_SETTING_KEYS.password] || "";
  return validateSftpBridgeConfig({
    host: input.host ?? settings[SFTP_SETTING_KEYS.host],
    port: input.port ?? settings[SFTP_SETTING_KEYS.port],
    username: input.username ?? settings[SFTP_SETTING_KEYS.username],
    password,
    bridgePath: input.bridgePath ?? settings[SFTP_SETTING_KEYS.bridgePath],
    pollIntervalSeconds: input.pollIntervalSeconds ?? settings[SFTP_SETTING_KEYS.pollIntervalSeconds],
  });
}

async function resolveSftpLogConfig(input = {}) {
  const settings = await getAllSettings();
  const password = input.password && !isMaskedSecret(input.password)
    ? input.password
    : settings[SFTP_SETTING_KEYS.password] || "";
  return {
    host: input.host ?? settings[SFTP_SETTING_KEYS.host],
    port: input.port ?? settings[SFTP_SETTING_KEYS.port],
    username: input.username ?? settings[SFTP_SETTING_KEYS.username],
    password,
    logPath: input.logPath ?? settings[SFTP_LOG_PATH_KEY],
  };
}

export const VALID_ACTIONS = new Set([
  "ping",
  "getServerInfo",
  "getWeather",
  "getGameTime",
  "getWorldStats",
  "getPlayerDetails",
  "getAllPlayerDetails",
  "healPlayer",
  "killPlayer",
  "teleportPlayer",
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "giveItem",
  "exportPlayerData",
  "importPlayerData",
  "triggerBlizzard",
  "triggerTropicalStorm",
  "triggerStorm",
  "stopWeather",
  "startRain",
  "stopRain",
  "setSnow",
  "generateWeather",
  "setTemperature",
  "setWind",
  "setFog",
  "setClouds",
  "setDayLight",
  "setNightStrength",
  "setDesaturation",
  "setViewDistance",
  "setAmbient",
  "setClimateFloat",
  "resetClimateOverrides",
  "getClimateFloats",
  "setGameTime",
  "triggerLightning",
  "playWorldSound",
  "playSoundNearPlayer",
  "triggerGunshot",
  "triggerAlarmSound",
  "createNoise",
  "sendToServerChat",
  "sendToAdminChat",
  "sendToGeneralChat",
  "getChatInfo",
  "getUtilitiesStatus",
  "restoreUtilities",
  "shutOffUtilities",
  "saveWorld",
  "getSandboxOptions",
  "getAllSandboxOptions",
  "setSandboxOption",
  "getZombieCount",
  "clearZombiesNearPlayer",
  "clearAllZombies",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "airdrop",
  "getSafehouses",
  "safehouseAddPlayer",
  "safehouseRemovePlayer",
  "safehouseSetOwner",
  "safehouseSetRespawn",
  "getFactions",
  "createFaction",
  "factionAddPlayer",
  "factionRemovePlayer",
  "factionSetTag",
  "removeFaction",
  "getVehiclesDetailed",
  "vehicleRepair",
  "vehicleSetAlarm",
  "vehicleSetSiren",
  "vehicleSetTrunkLocked",
  "vehicleSetFuel",
  "vehicleSetBattery",
  "removeVehicle",
  "removeVehiclesInArea",
  "spawnVehicleAt",
  "vehicleHotwire",
  "getTimeSpeed",
  "setTimeSpeed",
  "triggerHelicopterEvent",
  "stopHelicopterEvent",
  "triggerSwarmEvent",
  "runEventSequence",
  "getInfrastructureSnapshot",
  "moderationKickUser",
  "moderationBanUser",
  "moderationBanIP",
  "moderationBanSteamID",
  "getDebugLog",
  "setDebugMode",
  "getStats",
  "checkAPI",
  "getAvailableHandlers",
  "clearErrors",
  "getItemCatalog",
  "getVehicleCatalog",
  // Keep this allowlist aligned with the Lua handlers and dedicated routes.
  "debugItemScript",
]);

export const BRIDGE_ACTION_CAPABILITY = {
  moderationKickUser: "players.moderate",
  moderationBanUser: "players.moderate",
  moderationBanIP: "players.moderate",
  moderationBanSteamID: "players.moderate",
  setGodMode: "players.gm_tools",
  setInvisible: "players.gm_tools",
  setNoclip: "players.gm_tools",
  healPlayer: "players.gm_tools",
  debugItemScript: "bridge.diagnostics",
  playSoundNearPlayer: "players.endanger_or_impersonate",
  triggerGunshot: "players.endanger_or_impersonate",
  triggerAlarmSound: "players.endanger_or_impersonate",
  createNoise: "players.endanger_or_impersonate",
  spawnHordeNearPlayer: "players.endanger_or_impersonate",
  spawnHordeBehindPlayer: "players.endanger_or_impersonate",
  sendToAdminChat: "players.endanger_or_impersonate",
  sendToGeneralChat: "players.endanger_or_impersonate",
};

export const GM_TOOLS_ONLY_ACTIONS = new Set([
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "healPlayer",
]);

export const ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS = new Set([
  "playSoundNearPlayer",
  "triggerGunshot",
  "triggerAlarmSound",
  "createNoise",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "sendToAdminChat",
  "sendToGeneralChat",
]);

const requireBridgeCommand = requirePermission("bridge.command");
function requireBridgeCommandUnlessGmToolsOnly(req, res, next) {
  const { action } = req.body || {};
  if (
    typeof action === "string" &&
    (GM_TOOLS_ONLY_ACTIONS.has(action) || ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS.has(action))
  ) {
    return next();
  }
  return requireBridgeCommand(req, res, next);
}

const BRIDGE_USERNAME_REGEX = /^(?=.*\S)[^\x00-\x1F\x7F"\\]{1,64}$/;

const BLOCKED_BRIDGE_PATH_PREFIXES =
  process.platform === "win32"
    ? ["c:\\windows", "c:\\program files"]
    : ["/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev"];

function isValidBridgePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return false;
  if (!path.isAbsolute(inputPath)) return false;
  const resolved = path.resolve(inputPath);
  const lower = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return !BLOCKED_BRIDGE_PATH_PREFIXES.some((p) => lower.startsWith(p));
}


router.get("/status", async (req, res) => {
  const status = bridge.getStatus();

  let detectedPaths = null;
  let localInstall = null;
  let remoteBridgeVersionCheck = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer) {
      detectedPaths = {
        serverName: activeServer.serverName || activeServer.name,
        installPath: activeServer.installPath,
        zomboidDataPath: activeServer.zomboidDataPath,
        // Bridge path would be: zomboidDataPath/Saves/Multiplayer/{serverName}/panelbridge/
        // OR for dedicated servers: installPath/../Server_files/Saves/Multiplayer/{serverName}/panelbridge/
      };
      if (activeServer.isRemote) {
        const bundledVersion = getBundledBridgeVersion();
        const liveVersion = status.version || null;
        remoteBridgeVersionCheck = {
          bundledVersion,
          liveVersion,
          behind: liveVersion ? isBridgeVersionBehindBundled(liveVersion) : null,
        };
      } else {
        localInstall = {
          canAutoInstall: canAutoInstall(activeServer),
          ...checkBridgeInstalled(activeServer),
        };
      }
    }
  } catch (e) {
    // Ignore
  }

  res.json({
    ...status,
    modConnected: bridge.isModConnected(),
    detectedPaths,
    localInstall,
    remoteBridgeVersionCheck,
  });
});

router.post("/auto-configure", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const { serverId } = req.body || {};
    log.info(`POST /auto-configure (serverId=${serverId || "active"})`);

    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(400).json({
          error: `Server with ID ${serverId} not found.`,
          code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          params: sanitizeErrorParams({ serverId }),
        });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error:
            "No active server configured. Please configure a server first.",
          code: ErrorCode.PANELBRIDGE_AUTO_CONFIGURE_NO_ACTIVE_SERVER,
        });
      }
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res.status(400).json({
        error: "Server name not configured.",
        code: ErrorCode.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
      });
    }

    const possiblePaths = [];
    const searchedLocations = [];

    const safeReadDir = (dirPath) => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e) {
        return [];
      }
    };

    const addPath = (p, source, priority = 10) => {
      if (possiblePaths.some((pp) => pp.path === p)) return;

      const statusFile = path.join(p, "status.json");
      const initFile = path.join(p, ".init");
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);

      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p),
        priority,
      });
      searchedLocations.push({ path: p, source, hasStatus, hasInit });
    };

    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          "Lua",
          "panelbridge",
          serverName,
        ),
        "zomboidDataPath/Lua (cachedir)",
        1,
      );
    }

    addPath(
      path.join(os.homedir(), "Zomboid", "Lua", "panelbridge", serverName),
      "default Zomboid folder",
      2,
    );

    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath);
      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
          const luaPath = path.join(
            parentDir,
            item,
            "Lua",
            "panelbridge",
            serverName,
          );
          addPath(luaPath, `${item}/Lua`, 3);
        }
      }

      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
            const luaPath = path.join(
              grandParentDir,
              item,
              "Lua",
              "panelbridge",
              serverName,
            );
            addPath(luaPath, `${item}/Lua`, 4);
          }
        }
      }

      addPath(
        path.join(targetServer.installPath, "Lua", "panelbridge", serverName),
        "installPath/Lua",
        5,
      );
    }

    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1;
      if (!a.hasStatus && b.hasStatus) return 1;
      if (a.hasInit && !b.hasInit) return -1;
      if (!a.hasInit && b.hasInit) return 1;
      return a.priority - b.priority;
    });

    let foundPath = possiblePaths.find((p) => p.hasStatus);

    if (!foundPath) {
      foundPath = possiblePaths.find((p) => p.hasInit);
    }

    if (!foundPath) {
      foundPath = possiblePaths.find((p) => p.exists);
    }

    if (!foundPath && possiblePaths.length > 0) {
      possiblePaths.sort((a, b) => a.priority - b.priority);
      foundPath = possiblePaths[0];
    }

    if (!foundPath) {
      return res.status(400).json({
        error: `Could not determine bridge path for server "${serverName}". Make sure server installPath is set.`,
        code: ErrorCode.PANELBRIDGE_PATH_NOT_DETERMINED,
        searchedPaths: searchedLocations,
      });
    }


    if (bridge.isRunning) {
      bridge.stop();
    }

    bridge.configure(foundPath.path, true);
    bridge.start();

    let modInstalled = false;
    let modUpdated = false;
    try {
      const installDir = resolveInstallDir(targetServer);
      if (installDir) {
        const destLuaFile = path.join(
          installDir,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );

        let srcContent = getEmbeddedPanelBridgeLua();

        if (!srcContent) {
          const possibleModPaths = [
            path.join(__dirname, "..", "..", "..", "integrations", "panelbridge", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
          ];
          for (const modPath of possibleModPaths) {
            const candidate = path.join(
              modPath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            if (fs.existsSync(candidate)) {
              srcContent = fs.readFileSync(candidate, "utf8");
              break;
            }
          }
        }

        if (srcContent) {
          let needsCopy = !fs.existsSync(destLuaFile);

          if (!needsCopy) {
            modInstalled = true;
            try {
              const destContent = fs.readFileSync(destLuaFile, "utf8");
              const srcVersion = (srcContent.match(/VERSION\s*=\s*"([^"]+)"/) ||
                [])[1];
              const destVersion = (destContent.match(
                /VERSION\s*=\s*"([^"]+)"/,
              ) || [])[1];
              if (
                srcVersion &&
                destVersion &&
                compareModVersions(srcVersion, destVersion) > 0
              ) {
                needsCopy = true;
                modUpdated = true;
                log.info(
                  `PanelBridge mod update: ${destVersion} → ${srcVersion}`,
                );
              }
            } catch (_) {
              /* ignore read errors — keep existing */
            }
          }

          if (needsCopy) {
            writeLuaAtomic(destLuaFile, srcContent);
            modInstalled = true;
            if (modUpdated) {
              log.info("PanelBridge mod updated on server");
            } else {
              log.info("PanelBridge mod auto-installed to server");
            }
          }
        }
      }
    } catch (modError) {
      log.warn(`Auto-install mod failed: ${modError.message}`);
    }

    res.json({
      success: true,
      message: `Bridge auto-configured from server: ${targetServer.name}`,
      bridgePath: foundPath.path,
      serverName,
      source: foundPath.source,
      hasStatus: foundPath.hasStatus,
      modInstalled,
      modUpdated,
      searchedPaths: searchedLocations,
    });
    log.info(
      `Bridge auto-configured: path=${foundPath.path} source=${foundPath.source} hasStatus=${foundPath.hasStatus} modInstalled=${modInstalled}`,
    );
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/scan-server/:serverId", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const { serverId } = req.params;
    const targetServer = await getServer(serverId);

    if (!targetServer) {
      return res.status(404).json({
        success: false,
        error: `Server with ID ${serverId} not found.`,
        code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
        params: sanitizeErrorParams({ serverId }),
      });
    }

    const serverName = targetServer.serverName || targetServer.name;
    if (!serverName) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Server name not configured.",
          code: ErrorCode.PANELBRIDGE_SERVER_NAME_NOT_CONFIGURED,
        });
    }

    const possiblePaths = [];

    const safeReadDir = (dirPath) => {
      try {
        return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
      } catch (e) {
        return [];
      }
    };

    const addPath = (p, source, priority = 10) => {
      if (possiblePaths.some((pp) => pp.path === p)) return;

      const statusFile = path.join(p, "status.json");
      const initFile = path.join(p, ".init");
      const hasStatus = fs.existsSync(statusFile);
      const hasInit = fs.existsSync(initFile);

      possiblePaths.push({
        path: p,
        source,
        hasStatus,
        hasInit,
        exists: hasStatus || hasInit || fs.existsSync(p),
        priority,
      });
    };

    const defaultZomboidPath = path.join(
      os.homedir(),
      "Zomboid",
      "Lua",
      "panelbridge",
      serverName,
    );
    addPath(defaultZomboidPath, "default Zomboid folder", 0);

    if (targetServer.installPath) {
      const parentDir = path.dirname(targetServer.installPath);

      const parentContents = safeReadDir(parentDir);
      for (const item of parentContents) {
        if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
          const luaPath = path.join(
            parentDir,
            item,
            "Lua",
            "panelbridge",
            serverName,
          );
          addPath(luaPath, `${item}`, 1);
        }
      }

      const grandParentDir = path.dirname(parentDir);
      if (grandParentDir !== parentDir) {
        const grandParentContents = safeReadDir(grandParentDir);
        for (const item of grandParentContents) {
          if (item.startsWith("Server_files") || item.match(/Server.*files/i)) {
            const luaPath = path.join(
              grandParentDir,
              item,
              "Lua",
              "panelbridge",
              serverName,
            );
            addPath(luaPath, `${item} (grandparent)`, 2);
          }
        }
      }

      addPath(
        path.join(targetServer.installPath, "Lua", "panelbridge", serverName),
        "installPath/Lua",
        3,
      );
      addPath(
        path.join(parentDir, "Lua", "panelbridge", serverName),
        "parent/Lua",
        4,
      );
    }

    if (targetServer.zomboidDataPath) {
      addPath(
        path.join(
          targetServer.zomboidDataPath,
          "Lua",
          "panelbridge",
          serverName,
        ),
        "zomboidDataPath",
        1,
      );
    }

    possiblePaths.sort((a, b) => {
      if (a.hasStatus && !b.hasStatus) return -1;
      if (!a.hasStatus && b.hasStatus) return 1;
      if (a.hasInit && !b.hasInit) return -1;
      if (!a.hasInit && b.hasInit) return 1;
      return a.priority - b.priority;
    });

    const recommendedPath =
      possiblePaths.find((p) => p.hasStatus) ||
      possiblePaths.find((p) => p.hasInit) ||
      possiblePaths[0] ||
      null;

    res.json({
      success: true,
      serverName,
      serverId: targetServer.id,
      paths: possiblePaths,
      recommendedPath: recommendedPath?.path || null,
      recommendedSource: recommendedPath?.source || null,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

router.post("/auto-detect", requirePermission("bridge.setup"), async (req, res) => {
  const { serverName, zomboidUserFolder } = req.body || {};

  if (!serverName) {
    return res.status(400).json({
      error: "serverName is required",
      code: ErrorCode.PANELBRIDGE_SERVER_NAME_REQUIRED,
    });
  }

  if (zomboidUserFolder && !isValidBridgePath(zomboidUserFolder)) {
    return res.status(400).json({
      error: "Invalid zomboidUserFolder path",
      code: ErrorCode.PANELBRIDGE_INVALID_ZOMBOID_USER_FOLDER,
    });
  }

  try {
    await bridge.stopSftp();
    if (bridge.isRunning) {
      bridge.stop();
    }
    const bridgePath = bridge.autoDetect(serverName, zomboidUserFolder);
    bridge.start();
    res.json({
      success: true,
      message: "Bridge auto-configured and started",
      bridgePath,
    });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/configure", requirePermission("bridge.setup"), async (req, res) => {
  const { zomboidSavePath } = req.body || {};

  if (!zomboidSavePath) {
    return res.status(400).json({
      error: "zomboidSavePath is required",
      code: ErrorCode.PANELBRIDGE_SAVE_PATH_REQUIRED,
    });
  }

  if (!isValidBridgePath(zomboidSavePath)) {
    return res.status(400).json({
      error: "Invalid zomboidSavePath",
      code: ErrorCode.PANELBRIDGE_INVALID_SAVE_PATH,
    });
  }

  try {
    await bridge.stopSftp();
    if (bridge.isRunning) {
      bridge.stop();
    }
    const bridgePath = bridge.configure(zomboidSavePath);
    bridge.start();
    await setSetting("panelBridge", { bridgePath });
    res.json({
      success: true,
      message: "Bridge configured and started",
      bridgePath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/configure-direct", requirePermission("bridge.setup"), async (req, res) => {
  const { bridgePath: reqPath } = req.body || {};

  if (!reqPath || typeof reqPath !== "string") {
    return res.status(400).json({
      error: "bridgePath is required",
      code: ErrorCode.PANELBRIDGE_BRIDGE_PATH_REQUIRED,
    });
  }

  if (!path.isAbsolute(reqPath)) {
    return res.status(400).json({
      error: "Path must be absolute",
      code: ErrorCode.PANELBRIDGE_PATH_MUST_BE_ABSOLUTE,
    });
  }
  const resolved = path.resolve(reqPath);

  const lower =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (BLOCKED_BRIDGE_PATH_PREFIXES.some((p) => lower.startsWith(p))) {
    return res
      .status(400)
      .json({
      error: "Path targets a protected system directory",
      code: ErrorCode.PANELBRIDGE_PATH_PROTECTED_SYSTEM_DIR,
    });
  }

  try {
    await bridge.stopSftp();
    if (bridge.isRunning) {
      bridge.stop();
    }
    const configuredPath = bridge.configure(resolved, true);
    bridge.start();
    await setSetting("panelBridge", { bridgePath: configuredPath });
    res.json({
      success: true,
      message: "Bridge configured with manual path and started",
      bridgePath: configuredPath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/test", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpConfig(req.body);
    const result = await testSftpBridge(config);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error: sanitizeError(formatSftpError(error)),
      code: classifySftpErrorCode(error),
      params: sanitizeErrorParams({ detail: error?.message || String(error) }),
    });
  }
});

router.post("/sftp/configure", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpConfig(req.body);
    const cachePath = getSftpCachePath(config);
    await bridge.configureSftp(config, cachePath);
    for (const [field, key] of Object.entries(SFTP_SETTING_KEYS)) {
      const value = field === "enabled" ? true : config[field];
      if (value !== undefined) await setSetting(key, value);
    }
    res.json({ success: true, bridgePath: cachePath, transport: bridge.getStatus().transport });
  } catch (error) {
    res.status(400).json({
      error: sanitizeError(formatSftpError(error)),
      code: classifySftpErrorCode(error),
      params: sanitizeErrorParams({ detail: error?.message || String(error) }),
    });
  }
});

router.post("/sftp/logs/list", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpLogConfig(req.body);
    const result = await listSftpLogs(config);
    if (req.body?.logPath) await setSetting(SFTP_LOG_PATH_KEY, config.logPath);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/logs/tail", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const config = await resolveSftpLogConfig(req.body);
    const result = await readSftpLogTail(config, req.body?.name, req.body?.maxBytes);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sftp/config/list", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const settings = await getAllSettings();
    const password =
      req.body?.password && !isMaskedSecret(req.body.password)
        ? req.body.password
        : settings[SFTP_SETTING_KEYS.password] || "";
    const config = validateRemoteConfigTransport({
      host: req.body?.host ?? settings[SFTP_SETTING_KEYS.host],
      port: req.body?.port ?? settings[SFTP_SETTING_KEYS.port],
      username: req.body?.username ?? settings[SFTP_SETTING_KEYS.username],
      password,
      configPath: req.body?.configPath ?? settings[SFTP_CONFIG_PATH_KEY],
    });
    const result = await listRemoteConfigFiles(config);
    if (req.body?.configPath) {
      await setSetting(SFTP_CONFIG_PATH_KEY, config.configPath);
      resetRemoteConfigSession();
    }
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.post("/start", requirePermission("bridge.setup"), (req, res) => {
  try {
    bridge.start();
    res.json({ success: true, message: "Bridge started" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/stop", requirePermission("bridge.setup"), async (req, res) => {
  try {
    await bridge.stopSftp();
    bridge.stop();
    res.json({ success: true, message: "Bridge stopped" });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/scan-paths", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const foundBridges = [];
    const scannedDirs = [];

    const searchForBridge = (baseDir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth || !baseDir || !fs.existsSync(baseDir)) return;

      try {
        const contents = fs.readdirSync(baseDir, { withFileTypes: true });

        for (const item of contents) {
          if (!item.isDirectory()) continue;

          const itemPath = path.join(baseDir, item.name);

          if (item.name === "panelbridge") {
            try {
              const serverFolders = fs.readdirSync(itemPath, {
                withFileTypes: true,
              });
              for (const sf of serverFolders) {
                if (!sf.isDirectory()) continue;

                const serverPath = path.join(itemPath, sf.name);
                const statusFile = path.join(serverPath, "status.json");
                const initFile = path.join(serverPath, ".init");
                const hasStatus = fs.existsSync(statusFile);
                const hasInit = fs.existsSync(initFile);

                let statusAge = null;
                let modVersion = null;
                if (hasStatus) {
                  try {
                    const stats = fs.statSync(statusFile);
                    statusAge = Date.now() - stats.mtimeMs;
                    const content = JSON.parse(
                      fs.readFileSync(statusFile, "utf-8"),
                    );
                    modVersion = content.version;
                  } catch (e) {
                    log.debug(
                      `Failed to parse status for ${sf.name}: ${e.message}`,
                    );
                  }
                }

                foundBridges.push({
                  path: serverPath,
                  serverName: sf.name,
                  baseDir,
                  hasStatus,
                  hasInit,
                  statusAge,
                  modVersion,
                  isActive: statusAge !== null && statusAge < 60000, // Active if updated in last minute
                });
              }
            } catch (e) {
              log.debug(
                `Failed to scan panelbridge folder in ${itemPath}: ${e.message}`,
              );
            }
            continue;
          }

          if (item.name === "Lua") {
            const bridgePath = path.join(itemPath, "panelbridge");
            if (fs.existsSync(bridgePath)) {
              scannedDirs.push(bridgePath);
              searchForBridge(bridgePath, depth + 1, maxDepth);
            }
            continue;
          }

          if (
            item.name.startsWith("Server_files") ||
            item.name.match(/Server.*files/i)
          ) {
            scannedDirs.push(itemPath);
            searchForBridge(itemPath, depth + 1, maxDepth);
          }
        }
      } catch (e) {
        // Ignore errors reading directories
      }
    };

    const searchDirs = new Set();

    if (activeServer?.installPath) {
      searchDirs.add(activeServer.installPath);
      searchDirs.add(path.dirname(activeServer.installPath));
    }

    if (activeServer?.zomboidDataPath) {
      searchDirs.add(activeServer.zomboidDataPath);
      searchDirs.add(path.dirname(activeServer.zomboidDataPath));
    }

    if (bridge.bridgePath) {
      const parts = bridge.bridgePath.split(path.sep);
      const panelbridgeIdx = parts.indexOf("panelbridge");
      if (panelbridgeIdx > 0) {
        searchDirs.add(parts.slice(0, panelbridgeIdx).join(path.sep));
      }
    }

    for (const dir of searchDirs) {
      if (dir) {
        scannedDirs.push(dir);
        searchForBridge(dir);
      }
    }

    res.json({
      foundBridges,
      scannedDirs: [...new Set(scannedDirs)],
      currentPath: bridge.bridgePath,
      isRunning: bridge.isRunning,
      modConnected: bridge.isModConnected(),
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/refresh", requirePermission("bridge.setup"), (req, res) => {
  try {
    if (bridge.isRunning) {
      bridge.stop();
    }

    if (bridge.bridgePath) {
      bridge.start();
      res.json({
        success: true,
        message: "Bridge refreshed",
        bridgePath: bridge.bridgePath,
      });
    } else {
      res.json({
        success: false,
        message: "Bridge not configured - use auto-configure first",
      });
    }
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/ping", async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }

  try {
    const result = await bridge.ping();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/command", requireBridgeCommandUnlessGmToolsOnly, async (req, res) => {
  const activeServer = await getActiveServer();
  if (activeServer?.isRemote && !bridge.isSftpRunning() && !bridge.isRunning) {
    return res.status(400).json({
      error:
        "PanelBridge requires a configured mapped drive or a running SFTP bridge transport for remote servers.",
      code: ErrorCode.PANELBRIDGE_COMMAND_REMOTE_TRANSPORT_UNAVAILABLE,
    });
  }

  const { action, args } = req.body || {};

  if (!action) {
    return res.status(400).json({
      error: "action is required",
      code: ErrorCode.PANELBRIDGE_ACTION_REQUIRED,
    });
  }

  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      error: "Unknown or invalid action",
      code: ErrorCode.PANELBRIDGE_UNKNOWN_ACTION,
    });
  }

  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  ) {
    return res.status(400).json({
      error: "args must be an object",
      code: ErrorCode.PANELBRIDGE_ARGS_MUST_BE_OBJECT,
    });
  }

  const requiredCapability = BRIDGE_ACTION_CAPABILITY[action];
  if (requiredCapability) {
    const role = req.user ? await getRoleByName(req.user.role) : null;
    const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
    if (!capabilities.includes(requiredCapability)) {
      const isReplacementSemantics =
        GM_TOOLS_ONLY_ACTIONS.has(action) || ENDANGER_OR_IMPERSONATE_ONLY_ACTIONS.has(action);
      return res.status(403).json({
        error: isReplacementSemantics
          ? `"${action}" requires ${requiredCapability}.`
          : `"${action}" also requires ${requiredCapability}.`,
        code: ErrorCode.PANELBRIDGE_ACTION_CAPABILITY_REQUIRED,
      });
    }
  }

  if (action === "spawnVehicleAt") {
    const vehicle = args?.vehicle ?? args?.scriptName;
    const x = Number(args?.x);
    const y = Number(args?.y);
    const z = Number(args?.z ?? 0);
    if (typeof vehicle !== "string" || !VEHICLE_SCRIPT_REGEX.test(vehicle)) {
      return res.status(400).json({
      error: "Invalid vehicle script name",
      code: ErrorCode.PANELBRIDGE_INVALID_VEHICLE_SCRIPT_NAME,
    });
    }
    if (
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
      x < 0 || x > 24000 || y < 0 || y > 24000 || z < 0 || z > 8 ||
      (x === 0 && y === 0)
    ) {
      return res.status(400).json({
      error: "Invalid coordinates (x/y: 0-24000, z: 0-8)",
      code: ErrorCode.PANELBRIDGE_SPAWN_VEHICLE_INVALID_COORDS,
    });
    }

    try {
      const result = await req.app.get("rconService").addVehicleAt(vehicle, x, y, z);
      logBridgeCommand(action, args, result, result.success, 0).catch(() => {});
      return res.json({
        ...result,
        data: result.success ? {
          message: "Vehicle spawn requested",
          scriptName: vehicle,
          x: Math.floor(x),
          y: Math.floor(y),
          z: Math.floor(z),
        } : undefined,
      });
    } catch (error) {
      const message = sanitizeError(error?.message || "Vehicle spawn failed");
      logBridgeCommand(action, args, { error: message }, false, 0).catch(() => {});
      return res.status(500).json({ success: false, error: message });
    }
  }

  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }

  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }

  if (action === "airdrop" && args) {
    const VALID_PRESETS = [
      "military",
      "medical",
      "food",
      "building",
      "weapons",
      "tools",
    ];
    const x = Number(args.x),
      y = Number(args.y);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 24000 ||
      y < 0 ||
      y > 24000
    ) {
      return res
        .status(400)
        .json({
      error: "Invalid airdrop coordinates (valid: 0-24000)",
      code: ErrorCode.PANELBRIDGE_AIRDROP_INVALID_COORDS,
    });
    }
    if (
      args.preset &&
      (typeof args.preset !== "string" || !VALID_PRESETS.includes(args.preset))
    ) {
      return res
        .status(400)
        .json({
      error: `Invalid preset. Valid: ${VALID_PRESETS.join(", ")}`,
      code: ErrorCode.PANELBRIDGE_AIRDROP_INVALID_PRESET,
      params: sanitizeErrorParams({ presets: VALID_PRESETS.join(", ") }),
    });
    }
    if (args.items && (!Array.isArray(args.items) || args.items.length > 50)) {
      return res
        .status(400)
        .json({
      error: "items must be an array with at most 50 entries",
      code: ErrorCode.PANELBRIDGE_AIRDROP_ITEMS_ARRAY_INVALID,
    });
    }
    if (Array.isArray(args.items)) {
      for (const entry of args.items) {
        if (!entry || typeof entry !== "object") {
          return res
            .status(400)
            .json({
      error: "Each item must be an object with itemType",
      code: ErrorCode.PANELBRIDGE_AIRDROP_ITEM_INVALID,
    });
        }
        if (
          typeof entry.itemType !== "string" ||
          !ITEM_TYPE_REGEX.test(entry.itemType)
        ) {
          const itemType = String(entry.itemType).slice(0, 60);
          return res.status(400).json({
            error: `Invalid item type format: ${itemType}`,
            code: ErrorCode.PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID,
            params: sanitizeErrorParams({ itemType }),
          });
        }
        if (
          entry.count !== undefined &&
          (typeof entry.count !== "number" ||
            entry.count < 1 ||
            entry.count > 20)
        ) {
          return res.status(400).json({
      error: "Item count must be 1-20",
      code: ErrorCode.PANELBRIDGE_AIRDROP_ITEM_COUNT_INVALID,
    });
        }
      }
    }
  }

  const startTime = Date.now();
  try {
    log.info(
      `POST /command: action=${action} args=${JSON.stringify(args || {}).substring(0, 200)}`,
    );
    const result = await bridge.sendCommand(action, args || {});
    const durationMs = Date.now() - startTime;
    log.debug(`POST /command: action=${action} completed in ${durationMs}ms`);
    logBridgeCommand(action, args, result, true, durationMs).catch(() => {});
    res.json(result);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = sanitizeError(error?.message || "Bridge command failed");
    logBridgeCommand(action, args, { error: message }, false, durationMs).catch(
      () => {},
    );

    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};

    if (/timeout/i.test(message)) {
      return res
        .status(504)
        .json({ ...diagnosticFields, error: message, category: "timeout" });
    }
    if (
      /not configured|not running|unhealthy|not responding|stale|missing/i.test(
        message,
      )
    ) {
      return res
        .status(503)
        .json({ ...diagnosticFields, error: message, category: "bridge-unavailable" });
    }
    if (/invalid|required/i.test(message)) {
      return res
        .status(400)
        .json({ ...diagnosticFields, error: message, category: "validation" });
    }

    return res
      .status(500)
      .json({ ...diagnosticFields, error: message, category: "unknown" });
  }
});

router.get("/weather", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }

  try {
    const result = await bridge.getWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/server-info", requirePermission("players.view"), async (req, res) => {
  if (!bridge.bridgePath) {
    return res.status(400).json({
      error: "Bridge not configured",
      code: ErrorCode.BRIDGE_NOT_CONFIGURED,
    });
  }
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }

  try {
    const result = await bridge.getServerInfo();
    if (result?.data?.players && !Array.isArray(result.data.players)) {
      result.data.players = Object.values(result.data.players);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/blizzard", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { duration } = req.body || {};
  try {
    const result = await bridge.triggerBlizzard(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/tropical-storm", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { duration } = req.body || {};
  try {
    const result = await bridge.triggerTropicalStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/storm", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { duration } = req.body || {};
  if (
    duration !== undefined &&
    (typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 168)
  ) {
    return res
      .status(400)
      .json({
      error: "duration must be a number 0-168 (hours)",
      code: ErrorCode.PANELBRIDGE_STORM_DURATION_INVALID,
    });
  }
  try {
    const result = await bridge.triggerStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/generate", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { strength, frontType } = req.body || {};
  if (
    strength !== undefined &&
    (typeof strength !== "number" ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1)
  ) {
    return res.status(400).json({
      error: "strength must be a number 0-1",
      code: ErrorCode.PANELBRIDGE_WEATHER_STRENGTH_INVALID,
    });
  }
  if (
    frontType !== undefined &&
    (typeof frontType !== "number" ||
      !Number.isInteger(frontType) ||
      frontType < 0 ||
      frontType > 5)
  ) {
    return res.status(400).json({
      error: "frontType must be an integer 0-5",
      code: ErrorCode.PANELBRIDGE_WEATHER_FRONT_TYPE_INVALID,
    });
  }
  try {
    const result = await bridge.generateWeather(
      strength ?? 0.5,
      frontType ?? 0,
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/snow", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { enabled, intensity } = req.body || {};
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  if (
    intensity !== undefined &&
    intensity !== null &&
    (typeof intensity !== "number" ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > 1)
  ) {
    return res.status(400).json({
      error: "intensity must be a number 0-1",
      code: ErrorCode.BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setSnow(enabled !== false, intensity ?? null);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/weather/rain/start", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { intensity } = req.body || {};
  if (
    intensity !== undefined &&
    (typeof intensity !== "number" ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > 1)
  ) {
    return res.status(400).json({
      error: "intensity must be a number 0-1",
      code: ErrorCode.BRIDGE_INTENSITY_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.startRain(intensity ?? 0.5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/rain/stop", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/lightning", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, strike, light, rumble } = req.body || {};
  if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x))) {
    return res.status(400).json({
      error: "x must be a number",
      code: ErrorCode.PANELBRIDGE_LIGHTNING_X_INVALID,
    });
  }
  if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) {
    return res.status(400).json({
      error: "y must be a number",
      code: ErrorCode.PANELBRIDGE_LIGHTNING_Y_INVALID,
    });
  }
  try {
    const result = await bridge.triggerLightning(x, y, strike, light, rumble);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/climate/floats", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getClimateFloats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/float", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { floatId, value, enable } = req.body || {};
  if (floatId === undefined || value === undefined) {
    return res.status(400).json({
      error: "floatId and value are required",
      code: ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_FIELDS_REQUIRED,
    });
  }
  if (
    typeof floatId !== "number" ||
    !Number.isInteger(floatId) ||
    floatId < 0 ||
    floatId > 12
  ) {
    return res.status(400).json({
      error: "floatId must be an integer 0-12",
      code: ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_ID_INVALID,
    });
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return res.status(400).json({
      error: "value must be a number",
      code: ErrorCode.PANELBRIDGE_CLIMATE_FLOAT_VALUE_INVALID,
    });
  }
  try {
    const result = await bridge.setClimateFloat(
      floatId,
      value,
      enable !== false,
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/reset", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.resetClimateOverrides();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/temperature", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < -50 ||
      value > 50)
  ) {
    return res.status(400).json({
      error: "value must be a number -50 to 50",
      code: ErrorCode.PANELBRIDGE_TEMPERATURE_VALUE_INVALID,
    });
  }
  try {
    const result = await bridge.setTemperature(value ?? 22);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/wind", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({
      error: "value must be a number 0-1",
      code: ErrorCode.BRIDGE_VALUE_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setWind(value ?? 0.5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/fog", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({
      error: "value must be a number 0-1",
      code: ErrorCode.BRIDGE_VALUE_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setFog(value ?? 0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/climate/clouds", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { value } = req.body || {};
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    return res.status(400).json({
      error: "value must be a number 0-1",
      code: ErrorCode.BRIDGE_VALUE_MUST_BE_NUMBER_0_1,
    });
  }
  try {
    const result = await bridge.setClouds(value ?? 0);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/time", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getGameTime();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/time", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { hour, day, month, year } = req.body || {};
  if (
    hour !== undefined &&
    (typeof hour !== "number" ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23)
  ) {
    return res.status(400).json({
      error: "hour must be an integer 0-23",
      code: ErrorCode.PANELBRIDGE_GAMETIME_HOUR_INVALID,
    });
  }
  if (
    day !== undefined &&
    (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31)
  ) {
    return res.status(400).json({
      error: "day must be an integer 1-31",
      code: ErrorCode.PANELBRIDGE_GAMETIME_DAY_INVALID,
    });
  }
  if (
    month !== undefined &&
    (typeof month !== "number" ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12)
  ) {
    return res.status(400).json({
      error: "month must be an integer 1-12",
      code: ErrorCode.PANELBRIDGE_GAMETIME_MONTH_INVALID,
    });
  }
  if (
    year !== undefined &&
    (typeof year !== "number" ||
      !Number.isInteger(year) ||
      year < 1 ||
      year > 9999)
  ) {
    return res.status(400).json({
      error: "year must be an integer 1-9999",
      code: ErrorCode.PANELBRIDGE_GAMETIME_YEAR_INVALID,
    });
  }
  try {
    const result = await bridge.setGameTime({ hour, day, month, year });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/world/stats", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getWorldStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/world/save", requirePermission("server.control"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.saveWorld();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/players", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getAllPlayerDetails();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/players/:username", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  if (!BRIDGE_USERNAME_REGEX.test(req.params.username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.getPlayerDetails(req.params.username);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to get player details",
      code: ErrorCode.PANELBRIDGE_GET_PLAYER_DETAILS_FAILED,
    });
  }
});

router.post("/players/:username/teleport", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  if (!BRIDGE_USERNAME_REGEX.test(req.params.username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { x, y, z } = req.body || {};
  if (x === undefined || y === undefined) {
    return res.status(400).json({
      error: "x and y coordinates are required",
      code: ErrorCode.BRIDGE_XY_COORDS_REQUIRED,
    });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    (z !== undefined && typeof z !== "number")
  ) {
    return res.status(400).json({
      error: "Coordinates must be numbers",
      code: ErrorCode.PANELBRIDGE_TELEPORT_COORDS_NOT_NUMBERS,
    });
  }
  if (x < 0 || x > 24000 || y < 0 || y > 24000) {
    return res
      .status(400)
      .json({
        error: "x/y coordinates out of range (0-24000)",
        code: ErrorCode.PANELBRIDGE_TELEPORT_XY_OUT_OF_RANGE,
      });
  }
  if (z !== undefined && (z < 0 || z > 8)) {
    return res.status(400).json({
      error: "z coordinate out of range (0-8)",
      code: ErrorCode.PANELBRIDGE_TELEPORT_Z_OUT_OF_RANGE,
    });
  }
  try {
    const result = await bridge.teleportPlayer(req.params.username, x, y, z);
    res.json(result);
  } catch (error) {
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};
    res.status(500).json({
      ...diagnosticFields,
      error: "Teleport failed",
      code: ErrorCode.PANELBRIDGE_TELEPORT_FAILED,
    });
  }
});

router.post("/message", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
  }
  try {
    const result = await bridge.sendCommand("sendToServerChat", {
      message,
      isAlert: true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/sandbox", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.getSandboxOptions();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/commands", (req, res) => {
  res.json({
    commands: [
      { action: "ping", description: "Health check", args: {} },
      {
        action: "getServerInfo",
        description: "Get server info and player list",
        args: {},
      },
      { action: "saveWorld", description: "Trigger world save", args: {} },

      {
        action: "getWeather",
        description: "Get current weather data",
        args: {},
      },
      {
        action: "triggerBlizzard",
        description: "Trigger a blizzard",
        args: { duration: "number (hours, default: 2.0)" },
      },
      {
        action: "triggerTropicalStorm",
        description: "Trigger tropical storm",
        args: { duration: "number (hours, default: 2.0)" },
      },
      {
        action: "triggerStorm",
        description: "Trigger a storm",
        args: { duration: "number (hours, default: 2.0)" },
      },
      { action: "stopWeather", description: "Stop all weather", args: {} },
      {
        action: "generateWeather",
        description: "Generate weather period",
        args: {
          strength: "number 0-1 (default: 0.5)",
          frontType: "number 0=stationary, 1=cold, 2=warm (default: 0)",
        },
      },
      {
        action: "setSnow",
        description: "Enable/disable snow (auto-enables rain)",
        args: {
          enabled: "boolean (default: true)",
          intensity: "number 0-1 (optional, for rain start)",
        },
      },
      {
        action: "startRain",
        description: "Start rain",
        args: { intensity: "number 0-1 (default: 0.5)" },
      },
      { action: "stopRain", description: "Stop rain", args: {} },
      {
        action: "triggerLightning",
        description: "Trigger lightning bolt",
        args: {
          x: "number (optional)",
          y: "number (optional)",
          strike: "boolean (default: true)",
          light: "boolean (default: true)",
          rumble: "boolean (default: true)",
        },
      },

      {
        action: "getClimateFloats",
        description: "Get all climate float values (IDs 0-12)",
        args: {},
      },
      {
        action: "setClimateFloat",
        description: "Set climate float by ID",
        args: {
          floatId: "number 0-12 (required)",
          value: "number (required)",
          enable: "boolean (default: true)",
        },
      },
      {
        action: "resetClimateOverrides",
        description: "Reset all admin climate overrides",
        args: {},
      },
      {
        action: "setTemperature",
        description: "Set temperature (Celsius)",
        args: { value: "number -50 to +50 (default: 22)" },
      },
      {
        action: "setWind",
        description: "Set wind intensity",
        args: { value: "number 0-1 (default: 0.5)" },
      },
      {
        action: "setFog",
        description: "Set fog intensity",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setClouds",
        description: "Set cloud intensity",
        args: { value: "number 0-1 (default: 0)" },
      },

      {
        action: "setDayLight",
        description: "Set daylight strength",
        args: { value: "number 0-1 (default: 1.0)" },
      },
      {
        action: "setNightStrength",
        description: "Set night strength",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setDesaturation",
        description: "Set desaturation level",
        args: { value: "number 0-1 (default: 0)" },
      },
      {
        action: "setViewDistance",
        description: "Set view distance",
        args: { value: "number 0-1 (default: 1.0)" },
      },
      {
        action: "setAmbient",
        description: "Set ambient light",
        args: { value: "number 0-1 (default: 1.0)" },
      },

      {
        action: "getGameTime",
        description: "Get current game time/date",
        args: {},
      },
      {
        action: "setGameTime",
        description: "Set game time/date (only sent fields are changed)",
        args: {
          hour: "number (optional)",
          day: "number (optional)",
          month: "number 1-12 (optional)",
          year: "number (optional)",
        },
      },

      {
        action: "getWorldStats",
        description: "Get world statistics",
        args: {},
      },
      {
        action: "getSandboxOptions",
        description: "Get sandbox options (read-only)",
        args: {},
      },

      {
        action: "getAllPlayerDetails",
        description: "Get detailed info for all online players",
        args: {},
      },
      {
        action: "getPlayerDetails",
        description: "Get detailed info for a player",
        args: { username: "string (required)" },
      },
      {
        action: "teleportPlayer",
        description: "Teleport a player",
        args: {
          username: "string (required)",
          x: "number (required)",
          y: "number (required)",
          z: "number (default: 0)",
        },
      },
      {
        action: "healPlayer",
        description: "Fully heal a player",
        args: { username: "string (required)" },
      },
      {
        action: "killPlayer",
        description: "Kill a player",
        args: { username: "string (required)" },
      },
      {
        action: "setGodMode",
        description: "Toggle god mode",
        args: {
          username: "string (required)",
          enabled: "boolean (default: false)",
        },
      },
      {
        action: "setInvisible",
        description: "Toggle invisibility",
        args: {
          username: "string (required)",
          enabled: "boolean (default: false)",
        },
      },
      {
        action: "giveItem",
        description: "Give item to player",
        args: {
          username: "string (required)",
          itemType: 'string e.g. "Base.Axe" (required)',
          count: "number 1-100 (default: 1)",
        },
      },

      {
        action: "exportPlayerData",
        description: "Export full character data (perks, inventory, traits)",
        args: { username: "string (required)" },
      },
      {
        action: "importPlayerData",
        description: "Import/restore character data",
        args: {
          username: "string (required)",
          data: "object (required, from export)",
          options:
            "{ restorePerks: boolean, restoreInventory: boolean } (optional, both default true)",
        },
      },

      {
        action: "sendToServerChat",
        description:
          "Send message to server chat (isAlert=true for system announcement)",
        args: {
          message: "string (required)",
          isAlert: "boolean (default: false)",
        },
      },
      {
        action: "sendToAdminChat",
        description: "Send message to admin-only chat",
        args: { message: "string (required)" },
      },
      {
        action: "sendToGeneralChat",
        description: "Send message to general chat with custom author",
        args: {
          message: "string (required)",
          author: 'string (default: "[Panel]")',
        },
      },
      {
        action: "getChatInfo",
        description: "Get available chat types",
        args: {},
      },

      {
        action: "playWorldSound",
        description: "Create zombie-attracting sound at coordinates",
        args: {
          x: "number (required)",
          y: "number (required)",
          z: "number (default: 0)",
          radius: "number (default: 50)",
          volume: "number (default: 100)",
        },
      },
      {
        action: "playSoundNearPlayer",
        description: "Create sound at player location",
        args: {
          username: "string (required)",
          radius: "number (default: 50)",
          volume: "number (default: 100)",
        },
      },
      {
        action: "triggerGunshot",
        description: "Simulate gunshot (150m radius)",
        args: {
          x: "number",
          y: "number",
          username: "string (alternative to x/y)",
        },
      },
      {
        action: "triggerAlarmSound",
        description: "Trigger alarm sound (80m radius)",
        args: {
          x: "number",
          y: "number",
          username: "string (alternative to x/y)",
        },
      },
      {
        action: "createNoise",
        description: "Create custom noise",
        args: {
          x: "number",
          y: "number",
          radius: "number 10-500 (default: 100)",
          volume: "number 1-500 (default: 100)",
          username: "string (alternative to x/y)",
        },
      },

      {
        action: "getUtilitiesStatus",
        description: "Get power/water status",
        args: {},
      },
      {
        action: "restoreUtilities",
        description: "Restore power and/or water",
        args: {
          power: "boolean (default: true)",
          water: "boolean (default: true)",
        },
      },
      {
        action: "shutOffUtilities",
        description: "Shut off power and/or water",
        args: {
          power: "boolean (default: true)",
          water: "boolean (default: true)",
        },
      },

      {
        action: "getZombieCount",
        description: "Get zombie count in loaded cells",
        args: {},
      },
      {
        action: "clearZombiesNearPlayer",
        description: "Remove zombies near a player",
        args: { username: "string (required)", radius: "number (default: 50)" },
      },
      {
        action: "clearAllZombies",
        description: "Remove ALL zombies from loaded cells",
        args: {},
      },
      {
        action: "spawnHordeNearPlayer",
        description: "Spawn horde 50-70 tiles from player",
        args: {
          username: "string (required)",
          count: "number 1-500 (default: 50)",
        },
      },
      {
        action: "spawnHordeBehindPlayer",
        description: "Spawn horde behind player based on facing direction",
        args: {
          username: "string (required)",
          count: "number 1-500 (default: 50)",
        },
      },

      {
        action: "getSafehouses",
        description: "List all safehouses and key metadata",
        args: {},
      },
      {
        action: "safehouseAddPlayer",
        description: "Add player to safehouse members",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
        },
      },
      {
        action: "safehouseRemovePlayer",
        description: "Remove player from safehouse members",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
        },
      },
      {
        action: "safehouseSetOwner",
        description: "Transfer safehouse ownership",
        args: {
          safehouseRef: "string id/title (required)",
          owner: "string (required)",
        },
      },
      {
        action: "safehouseSetRespawn",
        description: "Enable/disable respawn in safehouse for user",
        args: {
          safehouseRef: "string id/title (required)",
          username: "string (required)",
          enabled: "boolean (required)",
        },
      },

      {
        action: "getFactions",
        description: "List all factions with members",
        args: {},
      },
      {
        action: "createFaction",
        description: "Create a faction",
        args: { name: "string (required)", owner: "string (required)" },
      },
      {
        action: "factionAddPlayer",
        description: "Add player to faction",
        args: {
          factionName: "string (required)",
          username: "string (required)",
        },
      },
      {
        action: "factionRemovePlayer",
        description: "Remove player from faction",
        args: {
          factionName: "string (required)",
          username: "string (required)",
        },
      },
      {
        action: "factionSetTag",
        description: "Set faction tag",
        args: {
          factionName: "string (required)",
          tag: "string (required, max 8)",
        },
      },
      {
        action: "removeFaction",
        description: "Remove faction entirely",
        args: { factionName: "string (required)" },
      },

      {
        action: "getVehiclesDetailed",
        description: "List loaded vehicles with telemetry",
        args: {},
      },
      {
        action: "vehicleRepair",
        description: "Repair a vehicle",
        args: { vehicleId: "number (required)" },
      },
      {
        action: "vehicleSetAlarm",
        description: "Toggle vehicle alarm and optionally trigger",
        args: { vehicleId: "number (required)", enabled: "boolean (required)" },
      },
      {
        action: "vehicleSetSiren",
        description: "Set vehicle siren mode",
        args: {
          vehicleId: "number (required)",
          mode: "number (optional)",
          enabled: "boolean (optional fallback)",
        },
      },
      {
        action: "vehicleSetTrunkLocked",
        description: "Lock/unlock vehicle trunk",
        args: { vehicleId: "number (required)", locked: "boolean (required)" },
      },

      {
        action: "triggerSwarmEvent",
        description: "Spawn a zombie swarm in rectangular area",
        args: {
          count: "number 1-500 (default: 25)",
          x1: "number (required)",
          y1: "number (required)",
          x2: "number (required)",
          y2: "number (required)",
        },
      },
      {
        action: "runEventSequence",
        description:
          "Execute chained operation steps (chat/weather/swarm/utilities/noise)",
        args: {
          steps: "array (required)",
          maxSteps: "number 1-50 (optional default: 20)",
        },
      },

      {
        action: "getInfrastructureSnapshot",
        description:
          "Get hydro/weather/temperature and optional sampled point data",
        args: {
          x: "number (optional)",
          y: "number (optional)",
          z: "number (optional default: 0)",
        },
      },

      {
        action: "moderationKickUser",
        description: "Kick a user through BanSystem",
        args: {
          username: "string (required)",
          reason: "string (optional)",
          description: "string (optional)",
        },
      },
      {
        action: "moderationBanUser",
        description: "Ban/unban user through BanSystem",
        args: {
          username: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },
      {
        action: "moderationBanIP",
        description: "Ban/unban IP through BanSystem",
        args: {
          ip: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },
      {
        action: "moderationBanSteamID",
        description: "Ban/unban SteamID through BanSystem",
        args: {
          steamId: "string (required)",
          reason: "string (optional)",
          ban: "boolean (default: true)",
        },
      },

      {
        action: "getDebugLog",
        description: "Get mod debug log entries",
        args: {
          limit: "number (default: 50)",
          minLevel: "string: DEBUG|INFO|WARN|ERROR (default: DEBUG)",
        },
      },
      { action: "getStats", description: "Get mod statistics", args: {} },
      {
        action: "setDebugMode",
        description: "Toggle verbose logging",
        args: { enabled: "boolean (required)" },
      },
      {
        action: "checkAPI",
        description: "Check API method availability",
        args: {
          object: "string (default: ClimateManager)",
          method: "string (optional, specific method to check)",
        },
      },
      {
        action: "getAvailableHandlers",
        description: "List all available command handlers",
        args: {},
      },
      { action: "clearErrors", description: "Clear mod error log", args: {} },
    ],
    climateFloatIds: {
      0: "FLOAT_DESATURATION",
      1: "FLOAT_GLOBAL_LIGHT_INTENSITY",
      2: "FLOAT_NIGHT_STRENGTH",
      3: "FLOAT_PRECIPITATION_INTENSITY",
      4: "FLOAT_TEMPERATURE",
      5: "FLOAT_FOG_INTENSITY",
      6: "FLOAT_WIND_INTENSITY",
      7: "FLOAT_WIND_ANGLE_INTENSITY",
      8: "FLOAT_CLOUD_INTENSITY",
      9: "FLOAT_AMBIENT",
      10: "FLOAT_VIEW_DISTANCE",
      11: "FLOAT_DAYLIGHT_STRENGTH",
      12: "FLOAT_HUMIDITY",
    },
  });
});

router.get("/mod-path", requirePermission("bridge.setup"), async (req, res) => {
  const possiblePaths = [
    path.join(__dirname, "..", "..", "..", "integrations", "panelbridge", "PanelBridge"),
    path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
    path.join(process.cwd(), "pz-mod", "PanelBridge"),
  ];

  let modPath = possiblePaths[0];
  let exists = false;

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      modPath = p;
      exists = true;
      break;
    }
  }

  let suggestedInstallPath = null;
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.installPath) {
      suggestedInstallPath = path.join(
        activeServer.installPath,
        "media",
        "lua",
        "server",
      );
    }
  } catch (e) {
    // Ignore
  }

  res.json({
    modPath,
    exists,
    files: exists ? fs.readdirSync(modPath) : [],
    suggestedInstallPath,
  });
});

router.post("/install-local", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res
        .status(400)
        .json({
          success: false,
          error: "No active server configured.",
          code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
        });
    }

    if (!canAutoInstall(server)) {
      return res.status(400).json({
        success: false,
        error:
          "Auto-install is not available for this server. It must be a local (non-remote) server with a writable install path and the PanelBridge source present.",
        code: ErrorCode.PANELBRIDGE_AUTO_INSTALL_NOT_AVAILABLE,
      });
    }

    const result = installBridge(server);
    if (!result.success) {
      return res.status(500).json(result);
    }

    res.json({
      ...result,
      message: `PanelBridge installed to ${result.targetPath}`,
      serverName: server.serverName || server.name,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: sanitizeError(error.message) });
  }
});

router.post("/install-mod-auto", requirePermission("bridge.setup"), async (req, res) => {
  try {
    const { serverId } = req.body || {};

    let targetServer;
    if (serverId) {
      targetServer = await getServer(serverId);
      if (!targetServer) {
        return res.status(400).json({
          error: `Server with ID ${serverId} not found.`,
          code: ErrorCode.PANELBRIDGE_SERVER_ID_NOT_FOUND,
          params: sanitizeErrorParams({ serverId }),
        });
      }
    } else {
      targetServer = await getActiveServer();
      if (!targetServer) {
        return res.status(400).json({
          error: "No active server configured.",
          code: ErrorCode.PANELBRIDGE_NO_ACTIVE_SERVER,
        });
      }
    }

    if (targetServer.isRemote) {
      return res.status(400).json({
        error: "Automatic PanelBridge installation is unavailable for remote servers. Copy PanelBridge.lua to the remote server's Lua folder using SFTP or the hosting provider's file manager.",
        code: ErrorCode.PANELBRIDGE_INSTALL_REMOTE_NOT_AVAILABLE,
      });
    }

    if (!canAutoInstall(targetServer)) {
      return res.status(400).json({
        error: "Automatic PanelBridge installation is unavailable. Configure an existing local server install folder with write permission, or use the manual install path.",
        code: ErrorCode.PANELBRIDGE_INSTALL_CANNOT_AUTO_INSTALL,
      });
    }

    const installResult = installBridge(targetServer);
    if (!installResult.success) {
      return res.status(500).json(installResult);
    }

    return res.json({
      ...installResult,
      message: installResult.message || `PanelBridge installed to ${installResult.targetPath}`,
      serverName: targetServer.serverName || targetServer.name,
    });

  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/install-mod", requirePermission("bridge.setup"), async (req, res) => {
  const body = req.body || {};
  const { serverLuaPath } = body;

  const targetPath = serverLuaPath || body.serverModsPath;

  if (!targetPath) {
    return res
      .status(400)
      .json({
        error: "serverLuaPath is required (path to media/lua/server/)",
        code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_REQUIRED,
      });
  }

  if (typeof targetPath !== "string" || targetPath.length > 500) {
    return res.status(400).json({
      error: "Invalid path format",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_FORMAT_INVALID,
    });
  }

  if (!path.isAbsolute(targetPath)) {
    return res.status(400).json({
      error: "Must be an absolute path",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_NOT_ABSOLUTE,
    });
  }
  const resolvedTarget = path.resolve(targetPath);
  const normalizedTarget = resolvedTarget.replace(/\\/g, "/");
  const targetLower = normalizedTarget.toLowerCase();
  if (
    !targetLower.endsWith("/media/lua/server") &&
    !targetLower.endsWith("/media/lua/server/")
  ) {
    return res
      .status(400)
      .json({
        error: "Path must point to a media/lua/server/ directory",
        code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_WRONG_DIRECTORY,
      });
  }

  let allowedTarget = null;
  try {
    const servers = await getServers();
    const normalizePath = (value) => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const normalizedResolvedTarget = normalizePath(resolvedTarget);

    for (const server of servers) {
      if (server?.isRemote) continue;
      let installDir;
      try {
        installDir = resolveInstallDir(server);
      } catch {
        continue;
      }
      if (!installDir || !path.isAbsolute(installDir)) {
        continue;
      }

      let canonicalInstallDir;
      try {
        canonicalInstallDir = fs.realpathSync(installDir);
      } catch {
        continue;
      }
      const candidate = path.join(
        canonicalInstallDir,
        "media",
        "lua",
        "server",
      );
      if (normalizePath(candidate) === normalizedResolvedTarget) {
        allowedTarget = candidate;
        break;
      }
    }
  } catch (error) {
    log.debug(`Configured PanelBridge target validation failed: ${error.message}`);
  }

  if (!allowedTarget) {
    return res.status(400).json({
      error:
        "Path must match the media/lua/server directory of a configured local server",
      code: ErrorCode.PANELBRIDGE_SERVER_LUA_PATH_NOT_CONFIGURED,
    });
  }

  try {
    let srcContent = getEmbeddedPanelBridgeLua();

    if (!srcContent) {
      const possiblePaths = [
        path.join(__dirname, "..", "..", "..", "integrations", "panelbridge", "PanelBridge"),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
      ];
      for (const p of possiblePaths) {
        const candidate = path.join(
          p,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        if (fs.existsSync(candidate)) {
          srcContent = fs.readFileSync(candidate, "utf8");
          break;
        }
      }
    }

    if (!srcContent) {
      return res.status(404).json({
        error: "Source mod not found (no embedded Lua and no on-disk pz-mod).",
        code: ErrorCode.PANELBRIDGE_SOURCE_MOD_NOT_FOUND,
      });
    }

    if (!fs.existsSync(allowedTarget)) {
      fs.mkdirSync(allowedTarget, { recursive: true, mode: 0o755 });
    }

    const destPath = path.join(allowedTarget, "PanelBridge.lua");
    writeLuaAtomic(destPath, srcContent);

    res.json({
      success: true,
      message: "PanelBridge.lua installed successfully",
      path: destPath,
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/sound/world", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, radius, volume } = req.body || {};
  if (x === undefined || y === undefined) {
    return res.status(400).json({
      error: "x and y coordinates are required",
      code: ErrorCode.BRIDGE_XY_COORDS_REQUIRED,
    });
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    x < 0 ||
    x > 24000 ||
    y < 0 ||
    y > 24000
  ) {
    return res
      .status(400)
      .json({
        error: "Coordinates out of range (valid: 0-24000)",
        code: ErrorCode.PANELBRIDGE_SOUND_COORDS_OUT_OF_RANGE,
      });
  }
  try {
    const result = await bridge.playWorldSound(x, y, z, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sound/near-player", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { username, radius, volume } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
  }
  try {
    const result = await bridge.playSoundNearPlayer(username, radius, volume);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to play sound",
      code: ErrorCode.PANELBRIDGE_PLAY_SOUND_FAILED,
    });
  }
});

router.post("/sound/gunshot", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, username } = req.body || {};
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.triggerGunshot({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to trigger gunshot",
      code: ErrorCode.PANELBRIDGE_TRIGGER_GUNSHOT_FAILED,
    });
  }
});

router.post("/sound/alarm", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, username } = req.body || {};
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.triggerAlarmSound({ x, y, z, username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/sound/noise", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { x, y, z, radius, volume, username } = req.body || {};
  if (username && !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.createNoise({
      x,
      y,
      z,
      radius,
      volume,
      username,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


async function persistUtilities(power, water, on) {
  const values = {};
  if (power) {
    values.ElecShut = on ? 9 : 1;
    values.ElecShutModifier = on ? 2147483647 : 0;
  }
  if (water) {
    values.WaterShut = on ? 9 : 1;
    values.WaterShutModifier = on ? 2147483647 : 0;
  }
  try {
    const { persisted, reason } = await persistSandboxValues(values);
    if (!persisted) {
      log.warn(`Utilities not persisted to SandboxVars.lua: ${reason}`);
    }
    return { persisted, persistReason: reason };
  } catch (error) {
    log.error(
      `Failed to persist utilities to SandboxVars.lua: ${error.message}`,
    );
    return { persisted: false, persistReason: sanitizeError(error.message) };
  }
}

router.get("/utilities/status", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  try {
    const result = await bridge.sendCommand("getUtilitiesStatus", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/utilities/restore", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { power, water } = req.body || {};
  log.info(
    `Restoring utilities - power: ${power !== false}, water: ${water !== false}`,
  );
  try {
    const result = await bridge.sendCommand("restoreUtilities", {
      power: power !== false,
      water: water !== false,
    });
    log.info(
      `Utilities restored successfully`,
      result?.debug ? { debug: result.debug } : {},
    );
    res.json({
      ...result,
      ...(await persistUtilities(power !== false, water !== false, true)),
    });
  } catch (error) {
    log.error(`Failed to restore utilities: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/utilities/shutoff", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { power, water } = req.body || {};
  log.info(
    `Shutting off utilities - power: ${power !== false}, water: ${water !== false}`,
  );
  try {
    const result = await bridge.sendCommand("shutOffUtilities", {
      power: power !== false,
      water: water !== false,
    });
    log.info(
      `Utilities shut off successfully`,
      result?.debug ? { debug: result.debug } : {},
    );
    res.json({
      ...result,
      ...(await persistUtilities(power !== false, water !== false, false)),
    });
  } catch (error) {
    log.error(`Failed to shut off utilities: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/character/export", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { username } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid or missing username",
      code: ErrorCode.BRIDGE_INVALID_OR_MISSING_USERNAME,
    });
  }
  try {
    const result = await bridge.sendCommand("exportPlayerData", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/character/import", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res
      .status(400)
      .json({
        error: "Bridge not running. Start it first.",
        code: ErrorCode.BRIDGE_NOT_RUNNING,
      });
  }
  const { username, data, options } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid or missing username",
      code: ErrorCode.BRIDGE_INVALID_OR_MISSING_USERNAME,
    });
  }
  if (!data) {
    return res.status(400).json({
      error: "Character data is required",
      code: ErrorCode.PANELBRIDGE_CHARACTER_DATA_REQUIRED,
    });
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({
      error: "Character data must be an object",
      code: ErrorCode.PANELBRIDGE_CHARACTER_DATA_NOT_OBJECT,
    });
  }
  const validSections = [
    "perks",
    "xp",
    "skills",
    "traits",
    "recipes",
    "stats",
    "inventory",
    "wornItems",
  ];
  const hasValidSection = validSections.some(
    (section) => data[section] !== undefined,
  );
  if (!hasValidSection) {
    return res.status(400).json({
      error:
        "Character data must contain at least one of: " +
        validSections.join(", "),
      code: ErrorCode.PANELBRIDGE_CHARACTER_DATA_NO_VALID_SECTION,
      params: sanitizeErrorParams({ sections: validSections.join(", ") }),
    });
  }
  let snapshotPath;
  try {
    const snapshot = await bridge.sendCommand("exportPlayerData", { username });
    const { dataDir } = getDataPaths();
    const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, "_");
    const exportDir = path.join(dataDir, "exports", safeUsername);
    fs.mkdirSync(exportDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    snapshotPath = path.join(
      exportDir,
      `${safeUsername}_pre-import_${timestamp}.json`,
    );
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(snapshot.data ?? snapshot, null, 2),
    );
  } catch (error) {
    return res.status(502).json({
      error: `Could not snapshot ${username}'s current data before import — refusing to overwrite without a recovery copy: ${sanitizeError(error.message)}`,
    });
  }

  try {
    const result = await bridge.sendCommand("importPlayerData", {
      username,
      data,
      options,
    });
    res.json({ ...result, snapshotFile: path.basename(snapshotPath) });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/players/:username/give-item", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { itemType, count = 1 } = req.body || {};
  if (
    !itemType ||
    typeof itemType !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/.test(itemType)
  ) {
    return res.status(400).json({
      error: 'itemType must be in Module.ItemName format (e.g., "Base.Axe")',
    });
  }
  if (typeof count !== "number" || count < 1 || count > 100) {
    return res.status(400).json({
      error: "count must be 1-100",
      code: ErrorCode.PANELBRIDGE_HORDE_COUNT_INVALID,
    });
  }
  try {
    const result = await bridge.sendCommand("giveItem", {
      username,
      itemType,
      count,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/heal", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.sendCommand("healPlayer", { username });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/kill", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  try {
    const result = await bridge.sendCommand("killPlayer", { username });
    res.json(result);
  } catch (error) {
    const diagnosticFields =
      error?.data && typeof error.data === "object" ? error.data : {};
    res
      .status(500)
      .json({ ...diagnosticFields, error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/godmode", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const result = await bridge.sendCommand("setGodMode", {
      username,
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/players/:username/invisible", requirePermission("players.gm_tools"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username } = req.params;
  if (!BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const result = await bridge.sendCommand("setInvisible", {
      username,
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/zombies/count", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getZombieCount", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/zombies/clear-near-player", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username, radius = 50 } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
  }
  if (typeof radius !== "number" || radius < 1 || radius > 500) {
    return res.status(400).json({
      error: "radius must be 1-500",
      code: ErrorCode.PANELBRIDGE_CLEAR_ZOMBIES_RADIUS_INVALID,
    });
  }
  try {
    const result = await bridge.sendCommand("clearZombiesNearPlayer", {
      username,
      radius,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/zombies/clear-all", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    log.info("Clearing all zombies");
    const result = await bridge.sendCommand("clearAllZombies", {});
    log.info(`Clear all zombies result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    log.warn(`Clear all zombies failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/zombies/spawn-near", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username, count = 50 } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
  }
  const safeCount = Math.min(Math.max(Math.floor(Number(count) || 50), 1), 500);
  try {
    log.info(`Spawning horde near player: ${username} (count: ${safeCount})`);
    const result = await bridge.sendCommand("spawnHordeNearPlayer", {
      username,
      count: safeCount,
    });
    log.info(`Spawn horde near result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    log.warn(`Spawn horde near failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/zombies/spawn-behind", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { username, count = 50 } = req.body || {};
  if (!username || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Valid username is required",
      code: ErrorCode.BRIDGE_VALID_USERNAME_REQUIRED,
    });
  }
  const safeCount = Math.min(Math.max(Math.floor(Number(count) || 50), 1), 500);
  try {
    log.info(`Spawning horde behind player: ${username} (count: ${safeCount})`);
    const result = await bridge.sendCommand("spawnHordeBehindPlayer", {
      username,
      count: safeCount,
    });
    log.info(`Spawn horde behind result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    log.warn(`Spawn horde behind failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/visual/view-distance", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res
      .status(400)
      .json({
        error: "value is required (number 0.0-1.0)",
        code: ErrorCode.PANELBRIDGE_VALUE_REQUIRED_NUMBER_0_1,
      });
  }
  try {
    const result = await bridge.sendCommand("setViewDistance", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/visual/daylight", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setDayLight", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/visual/night-strength", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setNightStrength", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/visual/desaturation", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setDesaturation", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/visual/ambient", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { value } = req.body || {};
  if (typeof value !== "number") {
    return res.status(400).json({
      error: "value is required (0.0-1.0)",
      code: ErrorCode.BRIDGE_VALUE_REQUIRED_0_1,
    });
  }
  try {
    const result = await bridge.sendCommand("setAmbient", { value });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/chat/info", requirePermission("server.world_events"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getChatInfo", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

async function trySendViaRcon(req, text) {
  const rconService = req.app.get("rconService");
  if (!rconService || !rconService.connected) return null;
  const result = await rconService.serverMessage(text, { skipLog: true });
  return result?.success ? result : null;
}

router.post("/chat/admin", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
  }
  try {
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToAdminChat", { message });
      if (result?.success && result?.data?.method !== "player:Say") {
        return res.json(result);
      }
    }
    const rconResult = await trySendViaRcon(req, `[ADMIN] ${message}`);
    if (rconResult) {
      return res.json({
        success: true,
        data: {
          message: "Admin message sent via RCON (visible to all)",
          method: "RCON",
        },
      });
    }
    return res
      .status(400)
      .json({
        error: "Neither PanelBridge nor RCON available for admin chat",
        code: ErrorCode.PANELBRIDGE_ADMIN_CHAT_UNAVAILABLE,
      });
  } catch (error) {
    try {
      const rconResult = await trySendViaRcon(req, `[ADMIN] ${message}`);
      if (rconResult) {
        return res.json({
          success: true,
          data: {
            message: "Admin message sent via RCON (visible to all)",
            method: "RCON",
          },
        });
      }
    } catch (_) {
      /* ignore */
    }
    res.status(500).json({
      error: "Failed to send admin message",
      code: ErrorCode.PANELBRIDGE_SEND_ADMIN_MESSAGE_FAILED,
    });
  }
});

router.post("/chat/general", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  const author =
    typeof req.body.author === "string"
      ? req.body.author.trim().slice(0, 64) || "Server"
      : "Server";
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
  }
  try {
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToGeneralChat", {
        message,
        author,
      });
      if (result?.success && result?.data?.method !== "player:Say") {
        return res.json(result);
      }
    }
    const rconResult = await trySendViaRcon(req, `[${author}] ${message}`);
    if (rconResult) {
      return res.json({
        success: true,
        data: { message: "Message sent via RCON", author, method: "RCON" },
      });
    }
    return res
      .status(400)
      .json({
        error: "Neither PanelBridge nor RCON available for chat",
        code: ErrorCode.PANELBRIDGE_CHAT_UNAVAILABLE,
      });
  } catch (error) {
    try {
      const rconResult = await trySendViaRcon(req, `[${author}] ${message}`);
      if (rconResult) {
        return res.json({
          success: true,
          data: { message: "Message sent via RCON", author, method: "RCON" },
        });
      }
    } catch (_) {
      /* ignore */
    }
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/chat/alert", requirePermission("server.world_events"), async (req, res) => {
  const { message, alert = true } = req.body || {};
  if (!message || typeof message !== "string" || message.length > 2000) {
    return res
      .status(400)
      .json({
        error: "message is required (max 2000 chars)",
        code: ErrorCode.BRIDGE_MESSAGE_REQUIRED,
      });
  }
  try {
    if (alert && bridge.isRunning) {
      const result = await bridge.sendCommand("sendToServerChat", {
        message,
        alert: true,
      });
      if (result?.success && result?.data?.method !== "player:Say") return res.json(result);
    }

    const rconResult = await trySendViaRcon(req, message);
    if (rconResult) {
      return res.json({
        success: true,
        data: {
          message: alert
            ? "Alert requested but RCON has no alert styling -- sent as a plain broadcast"
            : "Alert sent via RCON",
          isAlert: false,
          method: "RCON",
        },
      });
    }
    if (bridge.isRunning) {
      const result = await bridge.sendCommand("sendToServerChat", {
        message,
        alert,
      });
      return res.json(result);
    }
    return res
      .status(400)
      .json({
        error: "Neither RCON nor PanelBridge available",
        code: ErrorCode.PANELBRIDGE_RCON_AND_BRIDGE_UNAVAILABLE,
      });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/debug/log", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const limit = parseClampedInteger(req.query.limit, 50, 1, 500);
  const VALID_LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
  const minLevel = VALID_LOG_LEVELS.includes(req.query.level)
    ? req.query.level
    : "DEBUG";
  try {
    const result = await bridge.sendCommand("getDebugLog", { limit, minLevel });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/stats", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getStats", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/debug/mode", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const result = await bridge.sendCommand("setDebugMode", {
      enabled: enabled === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/api", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  const { object, method } = req.query;
  if (
    object &&
    (typeof object !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(object))
  ) {
    return res.status(400).json({
      error: "Invalid object name",
      code: ErrorCode.PANELBRIDGE_INVALID_OBJECT_NAME,
    });
  }
  if (
    method &&
    (typeof method !== "string" || !/^[a-zA-Z0-9_.]{1,100}$/.test(method))
  ) {
    return res.status(400).json({
      error: "Invalid method name",
      code: ErrorCode.PANELBRIDGE_INVALID_METHOD_NAME,
    });
  }
  try {
    const result = await bridge.sendCommand("checkAPI", { object, method });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/debug/handlers", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("getAvailableHandlers", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/debug/clear-errors", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.clearErrors();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/catalog/items", requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const db = await getDb();
    const catalog = db.data.itemCatalog || null;
    if (!catalog) {
      return res.json({ items: [], count: 0, scannedAt: null });
    }
    res.json(catalog);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/catalog/vehicles", requirePermission("players.gm_tools"), async (req, res) => {
  try {
    const db = await getDb();
    const catalog = db.data.vehicleCatalog || null;
    if (!catalog) {
      return res.json({ vehicles: [], count: 0, scannedAt: null });
    }
    res.json(catalog);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/catalog/scan-items", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan items",
      code: ErrorCode.PANELBRIDGE_SCAN_ITEMS_NOT_RUNNING,
    });
  }
  try {
    log.info("Scanning item catalog via PanelBridge...");
    const result = await bridge.sendCommand("getItemCatalog", {});
    if (!result || !result.success) {
      return res
        .status(500)
        .json({ error: result?.error || "Item scan failed" });
    }
    const catalog = {
      items: result.data?.items || [],
      count: result.data?.count || 0,
      scannedAt: new Date().toISOString(),
    };
    const db = await getDb();
    db.data.itemCatalog = catalog;
    await commitNow();
    log.info(`Item catalog cached: ${catalog.count} items`);
    res.json(catalog);
  } catch (error) {
    log.error("Item catalog scan failed:", error.message);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/catalog/scan-vehicles", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running — server must be online to scan vehicles",
      code: ErrorCode.PANELBRIDGE_SCAN_VEHICLES_NOT_RUNNING,
    });
  }
  try {
    log.info("Scanning vehicle catalog via PanelBridge...");
    const result = await bridge.sendCommand("getVehicleCatalog", {});
    if (!result || !result.success) {
      return res
        .status(500)
        .json({ error: result?.error || "Vehicle scan failed" });
    }
    const catalog = {
      vehicles: result.data?.vehicles || [],
      count: result.data?.count || 0,
      scannedAt: new Date().toISOString(),
    };
    const db = await getDb();
    db.data.vehicleCatalog = catalog;
    await commitNow();
    log.info(`Vehicle catalog cached: ${catalog.count} vehicles`);
    res.json(catalog);
  } catch (error) {
    log.error("Vehicle catalog scan failed:", error.message);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/catalog/debug-item-script", requirePermission("bridge.diagnostics"), async (req, res) => {
  if (!bridge.isRunning) {
    return res.status(400).json({
      error: "Bridge not running",
      code: ErrorCode.BRIDGE_NOT_RUNNING_BARE,
    });
  }
  try {
    const result = await bridge.sendCommand("debugItemScript", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;

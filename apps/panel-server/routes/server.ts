import express from "express";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import https from "https";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Server");
import {
  logServerEvent,
  setSetting,
  getSetting,
  getActiveServer,
  getServers,
} from "../database/init.ts";
import { sanitizeError, sanitizeIniValue } from "../utils/sanitize.ts";
import { hasIniKeyValue, setIniKeyLine } from "../utils/iniKeyWrite.ts";
import { applyUpnpToIni } from "../utils/upnpConfig.ts";
import {
  isSteamOperationIdle,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  hasActiveSteamOperation,
  STEAM_OPERATION_IDLE_TIMEOUT_MS,
} from "../services/activeSteamOperations.ts";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.ts";
import { requirePermission } from "../services/permissions.ts";
import {
  acquireLifecycleLock,
  getActiveLifecycleOperation,
  isLifecycleLockedForServer,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { ProgressCode } from "../utils/progressCodes.ts";
import { invalidateMapFolderScan } from "./chunks.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import { confineToRoots } from "../utils/browseRoots.ts";
import {
  createLinuxServiceLifecycle,
  isManagedLifecycleProvider,
} from "../services/linuxServiceLifecycle.ts";
import {
  buildServerSignal,
  resolveLifecycleState,
} from "../utils/serverStatusModel.ts";
import {
  attemptBoundedSaveBeforeForceStop,
  candidateIniPaths,
  ensureRconConfigured,
  formatWritablePathError,
  generateStartupScripts,
  isFirstBootMissingAdminPassword,
  monitorGracefulStop,
  refreshLaunchTargetBeforeStart,
  regenerateStartupScriptsWithBackup,
  sanitizeForBatch,
  waitForRconAfterStart,
} from "../services/serverLaunch.ts";
import {
  startServerAction,
  stopServerAction,
  forceStopServerAction,
  restartServerAction,
} from "../services/serverLifecycleActions.ts";
import { scoreServerProcessOwnership } from "../services/serverManager.ts";
import { buildLinuxWritableHomeEnv } from "../utils/steamEnvironment.ts";
import { resolveEnvRconHost } from "../services/rcon.ts";

export { applyUpnpToIni } from "../utils/upnpConfig.ts";

export {
  attemptBoundedSaveBeforeForceStop,
  candidateIniPaths,
  ensureRconConfigured,
  formatWritablePathError,
  generateStartupScripts,
  isFirstBootMissingAdminPassword,
  monitorGracefulStop,
  refreshLaunchTargetBeforeStart,
  regenerateStartupScriptsWithBackup,
  sanitizeForBatch,
  waitForRconAfterStart,
};

const router = express.Router();

const isWindows = process.platform === "win32";
const execAsync = promisify(exec);
const spawnProcess: any = spawn;

type AnyRecord = Record<string, any>;

export async function logServerEventBestEffort(...args: any[]) {
  try {
    await (logServerEvent as any)(...args);
  } catch (error: any) {
    log.warn(`Could not record server event: ${error.message}`);
  }
}

const PZ_INSTALL_MARKERS = [
  "ProjectZomboid64.json",
  "ProjectZomboid32.json",
  "StartServer64.bat",
  "StartServer32.bat",
  "start-server.sh",
];

function hasPzInstallMarker(dirPath: string) {
  return PZ_INSTALL_MARKERS.some((marker) => fs.existsSync(path.join(dirPath, marker)));
}

function getSteamCmdExe(steamcmdPath: string): string {
  const primary = path.join(
    steamcmdPath,
    isWindows ? "steamcmd.exe" : "steamcmd.sh",
  );
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(steamcmdPath, "steamcmd");
  if (!isWindows && fs.existsSync(fallback)) return fallback;
  if (!isWindows) {
    for (const sysPath of [
      "/usr/games/steamcmd",
      "/usr/bin/steamcmd",
      "/usr/local/bin/steamcmd",
    ]) {
      if (fs.existsSync(sysPath)) return sysPath;
    }
  }
  return primary;
}

async function saveAndResolveSteamCmdExe(candidatePath: string | null) {
  if (candidatePath) {
    const current = await getSetting("steamcmdPath");
    if (current !== candidatePath) {
      await setSetting("steamcmdPath", candidatePath);
    }
    return getSteamCmdExe(candidatePath);
  }
  const configuredPath = await getSetting("steamcmdPath");
  return configuredPath ? getSteamCmdExe(configuredPath) : null;
}

function emitRawSteamCmdLine(io: any, event: string, type: string, text: string) {
  io?.emit(event, { type, text });
}

function runSteamCmdFirstTimeSetup(
  steamcmdExe: string,
  installPath: string,
  io: any,
): Promise<string> {
  return new Promise((resolve, reject) => {
    io?.emit("steamcmd:status", {
      status: "initializing",
      message: "Initializing SteamCMD (first run)...",
      progressCode: ProgressCode.STEAMCMD_INITIALIZING,
    });
    log.info("Running SteamCMD first-time setup...");

    const firstRunOpts: AnyRecord = { cwd: installPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(installPath, "linux32"),
        path.join(installPath, "linux64"),
        installPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      firstRunOpts.env = {
        ...buildLinuxWritableHomeEnv(installPath),
        LD_LIBRARY_PATH: ldPaths,
      };
    }

    const steamcmd = spawnProcess(steamcmdExe, ["+quit"], firstRunOpts);
    steamcmd.stdout.on("data", (data: any) => {
      emitRawSteamCmdLine(io, "steamcmd:log", "stdout", data.toString());
    });
    steamcmd.stderr.on("data", (data: any) => {
      emitRawSteamCmdLine(io, "steamcmd:log", "stderr", data.toString());
    });
    steamcmd.once("close", (code: any) => {
      if (code !== 0 && code !== 7) {
        io?.emit("steamcmd:status", {
          status: "error",
          message: `SteamCMD setup failed with code ${code}`,
          progressCode: ProgressCode.STEAMCMD_SETUP_FAILED,
          params: { code },
        });
        reject(new Error(`SteamCMD first-run setup exited with code ${code}`));
        return;
      }
      if (!fs.existsSync(steamcmdExe)) {
        const message = `SteamCMD download completed but ${steamcmdExe} still missing`;
        io?.emit("steamcmd:status", {
          status: "error",
          message: `SteamCMD setup failed unexpectedly: ${message}`,
          progressCode: ProgressCode.STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR,
          params: { reason: message },
        });
        reject(new Error(message));
        return;
      }
      io?.emit("steamcmd:status", {
        status: "complete",
        message: "SteamCMD installed successfully!",
        path: installPath,
        progressCode: ProgressCode.STEAMCMD_INSTALL_COMPLETE,
      });
      log.info(`SteamCMD installed successfully to ${installPath}`);
      resolve(steamcmdExe);
    });
    steamcmd.once("error", (error: any) => {
      io?.emit("steamcmd:status", {
        status: "error",
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
        params: { reason: sanitizeError(error.message) },
      });
      reject(error);
    });
  });
}

async function provisionSteamCmdWindows(installPath: string, io: any): Promise<void> {
  const unzipper = await import("unzipper");
  const zipPath = path.join(installPath, "steamcmd.zip");
  const url = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      file.close();
      try {
        fs.unlinkSync(zipPath);
      } catch {
        /* best effort */
      }
      reject(error);
    };
    file.on("error", fail);

    const download = (downloadUrl: string) => {
      const request = https
        .get(downloadUrl, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            if (response.headers.location) {
              response.resume?.();
              download(response.headers.location);
            } else {
              fail(new Error("SteamCMD redirect did not include a URL"));
            }
            return;
          }
          if (response.statusCode !== 200) {
            fail(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.once("close", () => {
            if (settled) return;
            settled = true;
            resolve();
          });
        })
        .on("error", fail);
      request.setTimeout?.(120000, () => {
        request.destroy();
        fail(new Error("SteamCMD download timed out"));
      });
    };
    download(url);
  });

  io?.emit("steamcmd:status", {
    status: "extracting",
    message: "Extracting SteamCMD...",
    progressCode: ProgressCode.STEAMCMD_EXTRACTING,
  });
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.default.Extract({ path: installPath }))
    .promise();
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* best effort */
  }
}

async function ensureSteamCmdLinux(installPath: string, io: any) {
  const steamcmdExe = await saveAndResolveSteamCmdExe(installPath);
  if (steamcmdExe && fs.existsSync(steamcmdExe)) return steamcmdExe;

  const emit = (event: string, payload: any) => {
    try {
      io?.emit(event, payload);
    } catch {
      /* best effort */
    }
  };

  log.warn(
    `SteamCMD not found at ${steamcmdExe}; auto-downloading to ${installPath}...`,
  );
  emit("steamcmd:status", {
    status: "downloading",
    message: "SteamCMD missing — downloading it now...",
    progressCode: ProgressCode.STEAMCMD_LINUX_AUTO_DOWNLOAD_START,
  });

  if (!fs.existsSync(installPath)) {
    fs.mkdirSync(installPath, { recursive: true });
  }

  const tarUrl =
    "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
  const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");
  const safeTarPath = tarPath.replace(/'/g, "'\\''");
  const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
  const safeInstallPath = installPath.replace(/'/g, "'\\''");

  try {
    await execAsync(`curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  } catch (curlErr: any) {
    log.warn(`curl download failed (${curlErr.message}), trying wget...`);
    await execAsync(`wget -q -O '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  }

  emit("steamcmd:status", {
    status: "extracting",
    message: "Extracting SteamCMD...",
    progressCode: ProgressCode.STEAMCMD_EXTRACTING,
  });
  await execAsync(`tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`, {
    timeout: 30000,
  });
  try {
    fs.unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd.sh"), 0o755);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd"), 0o755);
  } catch {
    /* ignore */
  }

  if (!steamcmdExe) {
    throw new Error("SteamCMD executable path is unavailable after download");
  }
  return runSteamCmdFirstTimeSetup(steamcmdExe, installPath, io);
}

async function ensureSteamCmdWindows(installPath: string, io: any) {
  const steamcmdExe = await saveAndResolveSteamCmdExe(installPath);
  if (steamcmdExe && fs.existsSync(steamcmdExe)) return steamcmdExe;

  io?.emit("steamcmd:status", {
    status: "downloading",
    message: "SteamCMD missing — downloading it now...",
    progressCode: ProgressCode.STEAMCMD_LINUX_AUTO_DOWNLOAD_START,
  });
  if (!fs.existsSync(installPath)) {
    fs.mkdirSync(installPath, { recursive: true });
  }
  await provisionSteamCmdWindows(installPath, io);
  return runSteamCmdFirstTimeSetup(
    getSteamCmdExe(installPath),
    installPath,
    io,
  );
}

function normalizeSteamBranch(branch: any) {
  return !branch || branch === "stable" || branch === "public"
    ? "public"
    : branch;
}

function recoverMismatchedSteamBranchManifest(installPath: string, selectedBranch: string) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  const mountedBranch = manifest.match(
    /"MountedConfig"\s*\{[\s\S]*?"BetaKey"\s*"([^"]+)"/,
  )?.[1];
  const targetBranch = normalizeSteamBranch(selectedBranch);
  if (!mountedBranch || mountedBranch === targetBranch) return null;

  const backupPath = `${manifestPath}.bak-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { mountedBranch, targetBranch, backupPath };
}

export function hasSteamManifestAccessDeniedState(manifest: string) {
  return /"StateFlags"\s*"6"/.test(manifest);
}

function recoverBlockedSteamManifest(installPath: string) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  if (!hasSteamManifestAccessDeniedState(manifest)) return null;

  const backupPath = `${manifestPath}.bak-0x6-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { backupPath };
}

export const STEAMCMD_FIXED_CANDIDATE_PATHS = [
  "/home/steam/steamcmd",
  "/home/steam/Steam/steamcmd",
  "/opt/steamcmd",
];

export async function findSteamCmdPath() {
  const configuredPath = await getSetting("steamcmdPath");
  const candidates = [
    configuredPath,
    process.env.STEAMCMD_PATH,
    ...STEAMCMD_FIXED_CANDIDATE_PATHS,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(getSteamCmdExe(candidate))) return candidate;
  }

  return null;
}

const activeSteamOperations = getActiveSteamOperations();
// Only one provisioning flow may write SteamCMD's fixed archive paths in a
// panel process. activeSteamOperations is per-install and starts too late.
let steamcmdDownloadInProgress = false;

async function ensureSteamCmdInstalled(installPath: string, io: any) {
  if (steamcmdDownloadInProgress) {
    const error: any = new Error("A SteamCMD download is already in progress");
    error.code = ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS;
    throw error;
  }
  steamcmdDownloadInProgress = true;
  try {
    return isWindows
      ? await ensureSteamCmdWindows(installPath, io)
      : await ensureSteamCmdLinux(installPath, io);
  } finally {
    steamcmdDownloadInProgress = false;
  }
}

async function getServerConfigPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverConfigPath) {
    return activeServer.serverConfigPath;
  }
  const legacyPath = await getSetting("serverConfigPath");
  return legacyPath || null;
}

async function getServerName() {
  const activeServer = await getActiveServer();
  if (activeServer?.serverName) {
    return activeServer.serverName;
  }
  const legacyName = await getSetting("serverName");
  return legacyName || null;
}

function isValidServerName(name: any) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
    trimmed,
  );
}

export function isValidPath(inputPath: any) {
  if (!inputPath || typeof inputPath !== "string") return false;
  if (inputPath.includes("..")) return false;
  const normalized = path.normalize(inputPath);
  if (normalized.includes("..")) return false;
  if (!path.isAbsolute(normalized)) return false;
  return true;
}

export function resolveZomboidPaths(installPath: string, zomboidDataPath: string | null) {
  const defaultZomboidDataPath =
    process.env.PZ_SAVE_PATH ||
    path.join(path.dirname(installPath), `${path.basename(installPath)}_Data`);
  const zomboidPath = zomboidDataPath || defaultZomboidDataPath;

  return {
    zomboidPath,
    serverConfigPath: path.join(zomboidPath, "Server"),
    usesEnvironmentDataPath:
      !zomboidDataPath && Boolean(process.env.PZ_SAVE_PATH),
  };
}

function ensureWritableDirectory(directoryPath: string) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.accessSync(directoryPath, fs.constants.W_OK);
}

export function formatDirectoryReadError(
  directoryPath: string,
  osCode: string | undefined,
  platformIsWindows = isWindows,
) {
  return {
    message: platformIsWindows
      ? `Cannot read ${directoryPath} (${osCode}). Run the panel as an account that can read this folder.`
      : `Cannot read ${directoryPath} (${osCode}). The panel service account needs read and execute permission on this folder and every parent folder.`,
    code: platformIsWindows
      ? ErrorCode.DIRECTORY_READ_FAILED_WINDOWS
      : ErrorCode.DIRECTORY_READ_FAILED_POSIX,
    params: { path: directoryPath, code: osCode },
  };
}


export const BIND_PORT_MIN = 1024;
export const BIND_PORT_MAX = 65535;
export const GAME_PORT_MAX = BIND_PORT_MAX - 1;
export const DESTINATION_PORT_MIN = 1;
export const DESTINATION_PORT_MAX = 65535;
export const MEMORY_GB_MIN = 1;
export const MIN_MEMORY_GB_MAX = 64;
export const MAX_MEMORY_GB_MAX = 128;

type IntegerValidation =
  | { ok: false; message: string }
  | { ok: true; value: number };

function coerceIntInRange(
  value: any,
  min: number,
  max: number,
  defaultVal: any,
) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < min || num > max) return defaultVal;
  return num;
}

export function requireIntInRange(
  value: any,
  min: number,
  max: number,
  fieldLabel: string,
): IntegerValidation {
  const textValue = typeof value === "string" ? value.trim() : null;
  const num =
    typeof value === "number"
      ? value
      : textValue && /^[+-]?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (!Number.isInteger(num) || num < min || num > max) {
    return {
      ok: false,
      message: `${fieldLabel} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { ok: true, value: num };
}

router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    log.debug("GET /status");

    const status = await serverManager.getServerStatus();
    const rconStatus = rconService.getConfig();
    const serverSignal = buildServerSignal({
      connected: rconStatus.connected,
      connecting: Boolean(rconService.connecting || rconService.reconnecting),
    });
    const hostStatus = status.scanFailed
      ? "unknown"
      : status.running
        ? "running"
        : "stopped";

    res.json({
      ...status,
      rcon: rconStatus,
      state: resolveLifecycleState({
        hostStatus,
        rconStatus: serverSignal.status,
        operation: getActiveLifecycleOperation(),
      }),
    });
  } catch (error: any) {
    log.error(`Failed to get server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/network-interfaces", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    res.json({ interfaces: serverManager.listNetworkInterfaces() });
  } catch (error: any) {
    log.error(`Failed to list network interfaces: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

function lifecycleRuntime(req: any) {
  return {
    serverManager: req.app.get("serverManager"),
    rconService: req.app.get("rconService"),
    scheduler: req.app.get("scheduler"),
    discordBot: req.app.get("discordBot"),
    io: req.app.get("io"),
    checkServerStatusNow: req.app.get("checkServerStatusNow"),
  };
}

function lifecycleErrorResponse(error: any) {
  const details = error && typeof error === "object" ? error : {};
  const extra =
    details.params &&
    typeof details.params === "object" &&
    !Array.isArray(details.params)
      ? details.params
      : {};
  const body: AnyRecord = {
    ...extra,
    error: sanitizeError(details.message || error),
  };
  if (typeof details.code === "string") body.code = details.code;
  return {
    status: Number.isInteger(details.status) ? details.status : 500,
    body,
  };
}

async function runLifecycleRoute(
  req: any,
  res: any,
  action: (runtime: any, data: AnyRecord) => Promise<unknown>,
  data: AnyRecord = {},
) {
  try {
    return res.json(await action(lifecycleRuntime(req), data));
  } catch (error: any) {
    log.error(`Lifecycle action failed: ${error.message}`);
    const response = lifecycleErrorResponse(error);
    return res.status(response.status).json(response.body);
  }
}

router.post("/start", requirePermission("server.control"), async (req, res) =>
  runLifecycleRoute(req, res, startServerAction),
);

router.post("/stop", requirePermission("server.control"), async (req, res) =>
  runLifecycleRoute(req, res, stopServerAction),
);

router.post(
  "/force-stop",
  requirePermission("server.control"),
  async (req, res) => runLifecycleRoute(req, res, forceStopServerAction),
);

router.post("/restart", requirePermission("server.control"), async (req, res) =>
  runLifecycleRoute(req, res, restartServerAction, req.body || {}),
);
router.post("/save", requirePermission("server.control"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.save();
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to save world: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.post("/message", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "Message is required", code: ErrorCode.SERVER_MESSAGE_REQUIRED });
    }

    if (typeof message !== "string" || message.length > 1000) {
      return res
        .status(400)
        .json({ error: "Message must be a string under 1000 characters", code: ErrorCode.SERVER_MESSAGE_TOO_LONG });
    }

    const safeMessage = message.replace(/[\r\n]/g, " ");

    const result = await rconService.serverMessage(safeMessage);
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to send message: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/start-rain", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { intensity } = req.body || {};
    const result = await rconService.startRain(intensity);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop-rain", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopRain();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/start-storm", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { duration } = req.body || {};
    const result = await rconService.startStorm(duration);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopWeather();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/chopper", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerChopper();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/gunshot", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerGunshot();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/lightning", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body || {};
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.triggerLightning(username);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/thunder", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body || {};
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.triggerThunder(username);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/horde", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { count, username } = req.body || {};
    const safeCount = coerceIntInRange(count, 1, 500, 50);
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.createHorde(safeCount, username);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

const FALLBACK_BRANCHES = [
  { name: "public", description: "Current stable release. Recommended for most servers." },
  { name: "unstable", description: "Build 42 testing branch, including multiplayer. Back up saves and expect mod incompatibilities." },
  { name: "iwbums", description: "Experimental testing branch. Back up saves before switching." },
  { name: "legacy41", description: "Legacy Build 41 branch for older worlds and mods." },
];

router.get("/steamcmd/detect", requirePermission("server.world_events"), async (_req, res) => {
  try {
    const steamcmdPath = await findSteamCmdPath();
    if (!steamcmdPath) {
      return res.json({ found: false, message: "SteamCMD was not found automatically" });
    }

    const configuredPath = await getSetting("steamcmdPath");
    if (configuredPath !== steamcmdPath) {
      await setSetting("steamcmdPath", steamcmdPath);
    }

    res.json({
      found: true,
      path: steamcmdPath,
      executable: getSteamCmdExe(steamcmdPath),
      message: "SteamCMD found automatically",
    });
  } catch (error: any) {
    log.warn(`Failed to detect SteamCMD: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/branches", requirePermission("server.install"), async (req, res) => {
  try {
    const steamcmdPath =
      req.query.steamcmdPath || (await getSetting("steamcmdPath"));
    log.info(
      `GET /branches (steamcmdPath=${steamcmdPath || "not configured"})`,
    );

    if (!steamcmdPath) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD path not configured, using fallback branches",
      });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }

    const steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD not found, using fallback branches",
      });
    }

    const steamcmdArgs = [
      "+login",
      "anonymous",
      "+app_info_update",
      "1",
      "+app_info_print",
      "380870",
      "+quit",
    ];

    const result = await new Promise<{ code: any; stdout: string; stderr: string }>((resolve, reject) => {
      const branchSpawnOpts: AnyRecord = { cwd: steamcmdPath, timeout: 60000 };
      if (!isWindows) {
        const ldPaths = [
          path.join(steamcmdPath, "linux32"),
          path.join(steamcmdPath, "linux64"),
          steamcmdPath,
          process.env.LD_LIBRARY_PATH || "",
        ]
          .filter(Boolean)
          .join(":");
        branchSpawnOpts.env = {
          ...buildLinuxWritableHomeEnv(steamcmdPath),
          LD_LIBRARY_PATH: ldPaths,
        };
      }
      const steamcmd = spawnProcess(steamcmdExe, steamcmdArgs, branchSpawnOpts);

      let stdout = "";
      let stderr = "";
      let completed = false;

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          steamcmd.kill();
          reject(new Error("SteamCMD timed out"));
        }
      }, 30000);

      steamcmd.stdout.on("data", (data: any) => {
        stdout += data.toString();
      });

      steamcmd.stderr.on("data", (data: any) => {
        stderr += data.toString();
      });

      steamcmd.on("close", (code: any) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({ code, stdout, stderr });
        }
      });

      steamcmd.on("error", (err: any) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });

    const branches = parseSteamBranches(result.stdout);

    if (branches.length === 0) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "Could not parse branches from SteamCMD output",
      });
    }

    res.json({
      branches,
      source: "steam",
      message: "Branches fetched from Steam",
    });
  } catch (error: any) {
    log.warn(`Failed to fetch Steam branches: ${error.message}`);
    res.json({
      branches: FALLBACK_BRANCHES,
      source: "fallback",
      message: `Error: ${sanitizeError(error.message)}`,
    });
  }
});

function parseSteamBranches(output: string) {
  const branches: Array<{
    name: string;
    description: string;
    buildId: string | null;
    timeUpdated: string | null;
  }> = [];

  try {

    const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
    const altMatch = !branchesMatch
      ? output.match(/"branches"\s*\{([^]*?)\}\s*"installedrepots"/i)
      : null;

    if (!branchesMatch && !altMatch) {
      return branches;
    }

    const branchesSection = (branchesMatch || altMatch)?.[1];
    if (!branchesSection) return branches;

    const branchRegex = /^\s*"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gm;
    let match;

    while ((match = branchRegex.exec(branchesSection)) !== null) {
      const branchName = match[1];
      const branchContent = match[2];

      if (
        branchContent.includes('"pwdrequired"') &&
        branchContent.includes('"1"')
      ) {
        continue;
      }

      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);
      const description = descMatch
        ? descMatch[1]
        : branchName === "public"
          ? "Default stable branch"
          : "";

      const buildMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const buildId = buildMatch ? buildMatch[1] : null;

      const timeMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const timeUpdated = timeMatch
        ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString()
        : null;

      branches.push({
        name: branchName,
        description: description || branchName,
        buildId,
        timeUpdated,
      });
    }

    branches.sort((a, b) => {
      if (a.name === "public") return -1;
      if (b.name === "public") return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err: any) {
    log.warn(`Failed to parse Steam branches: ${err.message}`);
  }

  return branches;
}

function getBetaArgs(branch: string | boolean) {
  if (!branch || branch === "stable" || branch === "public") return [];
  if (branch === true) return ["-beta", "unstable"];
  return ["-beta", branch];
}

export async function getSteamLoginArgs() {
  const account = String((await getSetting("steamUpdateAccount")) || "").trim();
  if (account) {
    log.warn(
      "Ignoring steamUpdateAccount for SteamCMD updates: the panel cannot complete an interactive password or Steam Guard prompt",
    );
  }
  return ["+login", "anonymous"];
}

router.post("/install", requirePermission("server.install"), async (req, res) => {
  let activeOperationPath = null;
  try {
    const {
      steamcmdPath: suppliedSteamcmdPath,
      installPath,
      serverName,
      branch,
      useUnstable, // Legacy support
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      rconPassword,
      rconPort = 27015,
    } = req.body;

    const steamcmdPath =
      suppliedSteamcmdPath || (await findSteamCmdPath());

    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");
    log.info(
      `POST /install (steamcmd=${steamcmdPath}, install=${installPath}, server=${serverName}, branch=${selectedBranch}, noSteam=${useNoSteam}, debug=${useDebug})`,
    );

    if (!steamcmdPath || !installPath || !serverName) {
      const missing = [
        !steamcmdPath && "steamcmdPath",
        !installPath && "installPath",
        !serverName && "serverName",
      ].filter(Boolean);
      const detectionHint = !steamcmdPath
        ? ` SteamCMD was not found automatically either -- checked ${STEAMCMD_FIXED_CANDIDATE_PATHS.join(", ")}.`
        : "";
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(", ")}.${detectionHint}`,
        code: ErrorCode.INSTALL_MISSING_FIELDS,
      });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
        code: ErrorCode.SERVER_NAME_FORMAT_INVALID,
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path", code: ErrorCode.ZOMBOID_DATA_PATH_INVALID });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError: any) {
      const writableError = formatWritablePathError("install", installPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError: any) {
      const writableError = formatWritablePathError("data", zomboidPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    const minMemoryCheck = requireIntInRange(minMemory, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
    if (!minMemoryCheck.ok) {
      return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.INVALID_MIN_MEMORY });
    }
    const maxMemoryCheck = requireIntInRange(maxMemory, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
    if (!maxMemoryCheck.ok) {
      return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.INVALID_MAX_MEMORY });
    }
    const serverPortCheck = requireIntInRange(serverPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const rconPortCheck = requireIntInRange(rconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const safeMinMemory = minMemoryCheck.value;
    const safeMaxMemory = maxMemoryCheck.value;
    const safeServerPort = serverPortCheck.value;
    const safeRconPort = rconPortCheck.value;

    const installTargetServer = await resolveTargetServerForRunningCheck(installPath, {
      serverName,
      zomboidDataPath,
    });
    const installNotStoppedError = await checkSpecificServerStopped(
      req.app.get("serverManager"),
      installTargetServer,
      "installing to this path",
    );
    if (installNotStoppedError) {
      return res
        .status(installNotStoppedError.status)
        .json(installNotStoppedError.body);
    }
    if (isLifecycleLockedForServer(installTargetServer)) {
      return res.status(409).json(lifecycleInProgressResponse());
    }

    const safeAdminPassword = sanitizeForBatch(adminPassword);

    if (steamcmdDownloadInProgress) {
      return res.status(409).json({
        error: "A SteamCMD download is already in progress",
        code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
      });
    }
    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      try {
        steamcmdExe = await ensureSteamCmdInstalled(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr: any) {
        if (dlErr?.code === ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS) {
          return res.status(409).json({
            error: "A SteamCMD download is already in progress",
            code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
          });
        }
        return res.status(500).json({
          error: `SteamCMD not found and auto-download failed: ${sanitizeError(dlErr.message)}`,
          code: ErrorCode.STEAMCMD_AUTO_DOWNLOAD_FAILED,
        });
      }
    }

    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
      });
    }

    log.info(
      `Starting PZ server installation to ${installPath} (branch: ${selectedBranch})`,
    );

    activeSteamOperations.set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
      lastOutputAt: Date.now(),
      branch: selectedBranch,
      serverName,
    });
    activeOperationPath = normalizedPath;

    const betaArgs = getBetaArgs(selectedBranch);
    const loginArgs = await getSteamLoginArgs();
    const steamcmdArgs = [
      "+force_install_dir",
      installPath,
      ...loginArgs,
      "+app_update",
      "380870",
      ...betaArgs,
      "validate",
      "+quit",
    ];

    const io = req.app.get("io");

    const spawnOpts: AnyRecord = { cwd: steamcmdPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(steamcmdPath, "linux32"),
        path.join(steamcmdPath, "linux64"),
        steamcmdPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      spawnOpts.env = {
        ...buildLinuxWritableHomeEnv(steamcmdPath),
        LD_LIBRARY_PATH: ldPaths,
      };
    }
    const steamcmd = spawnProcess(steamcmdExe, steamcmdArgs, spawnOpts);
    const installOperation = activeSteamOperations.get(normalizedPath);
    if (!installOperation) {
      throw new Error("SteamCMD operation state disappeared before install started");
    }
    installOperation.pid = steamcmd.pid;
    let killedByWatchdog = false;
    const installWatchdog = setInterval(() => {
      const activeOperation = activeSteamOperations.get(normalizedPath);
      if (!activeOperation) return;
      if (!isSteamOperationIdle(activeOperation)) return;

      log.error(
        `SteamCMD ${activeOperation.type} produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
      );
      killedByWatchdog = true;
      steamcmd.kill();
    }, 30_000);
    installOperation.watchdog = installWatchdog;
    installWatchdog.unref?.();

    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    steamcmd.stdout.on("data", (data: any) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stdoutBuffer += text;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "install:log", "stdout", line);
          log.info(`SteamCMD: ${line}`);
        }
      }
    });

    steamcmd.stderr.on("data", (data: any) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stderrBuffer += text;

      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "install:log", "stderr", line);
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });

    steamcmd.on("close", async (code: any) => {
      if (stdoutBuffer.trim()) {
        emitRawSteamCmdLine(io, "install:log", "stdout", stdoutBuffer.trim());
        log.info(`SteamCMD: ${stdoutBuffer.trim()}`);
      }
      if (stderrBuffer.trim()) {
        emitRawSteamCmdLine(io, "install:log", "stderr", stderrBuffer.trim());
        log.warn(`SteamCMD stderr: ${stderrBuffer.trim()}`);
      }

      if (code === 0) {
        log.info("PZ server installation completed successfully");

        const warnings = [];

        try {
          await setSetting("serverPath", installPath);
          await setSetting("serverName", serverName);
          await setSetting("minMemory", minMemory);
          await setSetting("maxMemory", maxMemory);
          await setSetting("serverPort", serverPort);
          await setSetting("useUpnp", useUpnp);

          if (zomboidDataPath) {
            await setSetting("zomboidDataPath", zomboidDataPath);
          } else {
            await setSetting("zomboidDataPath", zomboidPath);
            io.emit("install:log", {
              type: "stdout",
              text: `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
              progressCode: usesEnvironmentDataPath
                ? ProgressCode.DATA_FOLDER_USING_CONFIGURED
                : ProgressCode.DATA_FOLDER_USING_ISOLATED,
              params: { path: zomboidPath },
            });
          }

          await setSetting("serverConfigPath", serverConfigPath);
        } catch (settingsError: any) {
          log.error(`Failed to save install settings: ${settingsError.message}`);
          warnings.push({
            progressCode: ProgressCode.INSTALL_SETTINGS_SAVE_FAILED,
            message: `Server files installed, but some install settings could not be saved (${sanitizeError(settingsError.message)}). Re-check them under Settings once the panel is back up.`,
            params: { fields: "serverPath, serverName, memory, port, UPnP, data paths", reason: sanitizeError(settingsError.message) },
          });
        }

        try {
          ensureWritableDirectory(serverConfigPath);
        } catch (dirError: any) {
          log.error(
            `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
          );
          const writableError = formatWritablePathError("data", zomboidPath);
          const bareMetalCommand =
            writableError.code === ErrorCode.WRITABLE_PATH_DATA_BAREMETAL
              ? `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}"`
              : null;
          io.emit("install:complete", {
            success: false,
            message: bareMetalCommand
              ? `${writableError.message} For example: ${bareMetalCommand}`
              : writableError.message,
            installPath,
            serverName,
            progressCode: writableError.code,
            params: {
              ...writableError.params,
              reason: dirError.code || dirError.message,
              ...(bareMetalCommand ? { command: bareMetalCommand } : {}),
            },
          });
          activeSteamOperations.delete(normalizedPath);
          return;
        }

        if (rconPassword) {
          try {
            await setSetting("rconPassword", rconPassword);
            await setSetting("rconPort", rconPort);
            await setSetting("rconHost", resolveEnvRconHost());
            io.emit("install:log", {
              type: "stdout",
              text: `RCON settings saved (port: ${rconPort})`,
              progressCode: ProgressCode.RCON_SETTINGS_SAVED,
              params: { port: rconPort },
            });
          } catch (rconSettingsError: any) {
            log.error(`Failed to save RCON settings: ${rconSettingsError.message}`);
            warnings.push({
              progressCode: ProgressCode.INSTALL_SETTINGS_SAVE_FAILED,
              message: `Server files installed, but the RCON password/port could not be saved (${sanitizeError(rconSettingsError.message)}). Re-check them under Settings once the panel is back up.`,
              params: { fields: "RCON password, port, host", reason: sanitizeError(rconSettingsError.message) },
            });
          }
        }

        try {
          const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
          if (!fs.existsSync(iniPath)) {
            if (!fs.existsSync(serverConfigPath)) {
              fs.mkdirSync(serverConfigPath, { recursive: true });
            }
            const lines = [
              "# Auto-generated by Zomboid Control Panel",
              "# PZ will add remaining default settings on first server start",
              `UPnP=${useUpnp ? "true" : "false"}`,
            ];
            if (rconPassword) {
              const safeRconPw = sanitizeIniValue(rconPassword);
              lines.push(`RCONPort=${safeRconPort}`, `RCONPassword=${safeRconPw}`);
            }
            writeFileAtomic(iniPath, lines.join("\n") + "\n", {
              encoding: "utf-8",
              mode: 0o600,
            });
            log.info(
              `Pre-created INI at ${iniPath} (UPnP=${useUpnp}${rconPassword ? ", RCON configured" : ""})`,
            );
            io.emit("install:log", rconPassword
              ? {
                  type: "stdout",
                  text: "Pre-created server INI with RCON credentials",
                  progressCode: ProgressCode.INI_PRECREATED_WITH_RCON,
                }
              : {
                  type: "stdout",
                  text: "Pre-created server INI with UPnP setting",
                  progressCode: ProgressCode.INI_PRECREATED_WITH_UPNP,
                });
          }
        } catch (iniError: any) {
          log.warn(`Failed to pre-create INI: ${iniError.message}`);
          const permissionHint =
            iniError.code === "EACCES"
              ? ` ${formatWritablePathError("data", serverConfigPath).message}`
              : "";
          warnings.push({
            progressCode: ProgressCode.INSTALL_RCON_INI_PRECREATE_FAILED,
            message: `Could not pre-write ${rconPassword ? "the RCON password" : "the UPnP setting"} into the server config (${sanitizeError(iniError.message)}).${permissionHint} This is retried automatically the next time you start the server.`,
            params: { reason: sanitizeError(iniError.message) },
          });
        }

        try {
          const scripts = generateStartupScripts({
            installPath,
            serverName,
            minMemory: safeMinMemory,
            maxMemory: safeMaxMemory,
            zomboidDataPath: zomboidPath,
            adminPassword: safeAdminPassword,
            serverPort: safeServerPort,
            useNoSteam,
            useDebug,
          });

          const batchPath = path.join(
            installPath,
            `StartServer_${serverName}.bat`,
          );
          writeFileAtomic(batchPath, scripts.bat, "utf8");
          log.info(`Created custom startup batch: ${batchPath}`);

          const shellPath = path.join(
            installPath,
            `start-server_${serverName}.sh`,
          );
          writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
            encoding: "utf8",
            mode: 0o750,
          });
          log.info(`Created custom startup script: ${shellPath}`);

          const scriptName =
            process.platform === "win32"
              ? `StartServer_${serverName}.bat`
              : `start-server_${serverName}.sh`;
          io.emit("install:log", {
            type: "stdout",
            text: `Created custom startup script: ${scriptName}`,
            progressCode: ProgressCode.STARTUP_SCRIPT_CREATED,
            params: { scriptName },
          });
        } catch (batchError: any) {
          log.warn(`Failed to create startup scripts: ${batchError.message}`);
          warnings.push({
            progressCode: ProgressCode.INSTALL_STARTUP_SCRIPT_FAILED,
            message: `Could not generate this server's custom startup script (${sanitizeError(batchError.message)}). The server can still be started -- it will use the default script until this regenerates, which also happens automatically on the next start.`,
            params: { reason: sanitizeError(batchError.message) },
          });
        }

        logServerEvent(
          "server_install",
          `Installed PZ server to ${installPath} (${selectedBranch} branch)`,
        );

        if (!hasPzInstallMarker(installPath)) {
          log.warn(
            `SteamCMD exited 0 but no recognizable PZ server files were found at ${installPath}`,
          );
          warnings.push({
            progressCode: ProgressCode.INSTALL_MISSING_GAME_FILES,
            message:
              "SteamCMD reported success, but no recognizable game files were found at the install path. Check the SteamCMD log above for a hidden error (a rate limit or an interrupted download can still exit 0), and verify the install path before starting this server.",
          });
        }

        try {
          const possibleModPaths = [
            path.join(__dirname, "..", "..", "..", "integrations", "panelbridge", "PanelBridge"),
            path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
            path.join(process.cwd(), "pz-mod", "PanelBridge"),
          ];

          let modSourcePath = null;
          for (const p of possibleModPaths) {
            if (fs.existsSync(p)) {
              modSourcePath = p;
              break;
            }
          }

          if (modSourcePath) {
            const sourceLuaFile = path.join(
              modSourcePath,
              "media",
              "lua",
              "server",
              "PanelBridge.lua",
            );
            const destLuaDir = path.join(installPath, "media", "lua", "server");
            const destLuaFile = path.join(destLuaDir, "PanelBridge.lua");

            if (fs.existsSync(sourceLuaFile)) {
              if (!fs.existsSync(destLuaDir)) {
                fs.mkdirSync(destLuaDir, { recursive: true });
              }
              fs.copyFileSync(sourceLuaFile, destLuaFile);
              io.emit("install:log", {
                type: "stdout",
                text: "PanelBridge mod installed automatically",
                progressCode: ProgressCode.PANELBRIDGE_AUTO_INSTALLED,
              });
              log.info("PanelBridge mod auto-installed to server");
            }
          }
        } catch (modError: any) {
          log.warn(
            `Failed to auto-install PanelBridge mod: ${modError.message}`,
          );
        }

        io.emit("install:complete", {
          success: true,
          message: "Server installed successfully",
          installPath,
          serverName,
          zomboidDataPath: zomboidPath, // Send back the computed data path
          serverConfigPath,
          branch: selectedBranch,
          rconPort: safeRconPort,
          hasRconPassword: !!rconPassword,
          serverPort: safeServerPort,
          minMemory: safeMinMemory,
          maxMemory: safeMaxMemory,
          progressCode: ProgressCode.INSTALL_COMPLETE_SUCCESS,
          warnings,
        });
      } else if (killedByWatchdog) {
        const idleMinutes = STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000;
        log.error(
          `SteamCMD produced no output for ${idleMinutes} minutes and was stopped`,
        );
        io.emit("install:complete", {
          success: false,
          message: `Installation was stopped after ${idleMinutes} minutes with no output from SteamCMD -- it may have stalled or lost its connection. Try again.`,
          output,
          progressCode: ProgressCode.INSTALL_WATCHDOG_KILLED,
          params: { minutes: idleMinutes },
        });
      } else {
        log.error(`SteamCMD exited with code ${code}`);
        io.emit("install:complete", {
          success: false,
          message: `Installation failed with exit code ${code}`,
          output,
          progressCode: ProgressCode.INSTALL_FAILED_EXIT_CODE,
          params: { code },
        });
      }

      clearActiveSteamOperation(normalizedPath);
    });

    steamcmd.on("error", (error: any) => {
      clearActiveSteamOperation(normalizedPath);

      log.error(`SteamCMD error: ${error.message}`);
      io.emit("install:complete", {
        success: false,
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
        params: { reason: sanitizeError(error.message) },
      });
    });

    res.json({
      success: true,
      message: "Installation started. Check the log for progress.",
      installPath,
      branch: selectedBranch,
    });
  } catch (error: any) {
    if (activeOperationPath) {
      activeSteamOperations.delete(activeOperationPath);
    }
    log.error(`Installation error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/quick-setup", requirePermission("server.install"), async (req, res) => {
  try {
    const {
      installPath,
      serverName,
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      rconPassword,
      rconPort = 27015,
    } = req.body;

    if (!installPath || !serverName) {
      return res
        .status(400)
        .json({ error: "Missing required fields: installPath, serverName", code: ErrorCode.QUICK_SETUP_MISSING_FIELDS });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
        code: ErrorCode.SERVER_NAME_FORMAT_INVALID,
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path", code: ErrorCode.ZOMBOID_DATA_PATH_INVALID });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    const startServerBat = path.join(installPath, "StartServer64.bat");
    const startServerSh = path.join(installPath, "start-server.sh");
    const javaFolder = path.join(installPath, "jre64");

    if (
      !fs.existsSync(startServerBat) &&
      !fs.existsSync(startServerSh) &&
      !fs.existsSync(javaFolder)
    ) {
      return res.status(400).json({
        error:
          "Server files not found. Make sure the path contains Project Zomboid dedicated server files.",
        code: ErrorCode.QUICK_SETUP_SERVER_FILES_NOT_FOUND,
      });
    }

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError: any) {
      const writableError = formatWritablePathError("install", installPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError: any) {
      const writableError = formatWritablePathError("data", zomboidPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    const minMemoryCheck = requireIntInRange(minMemory, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
    if (!minMemoryCheck.ok) {
      return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.INVALID_MIN_MEMORY });
    }
    const maxMemoryCheck = requireIntInRange(maxMemory, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
    if (!maxMemoryCheck.ok) {
      return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.INVALID_MAX_MEMORY });
    }
    const serverPortCheck = requireIntInRange(serverPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const rconPortCheck = requireIntInRange(rconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const safeMinMemory = minMemoryCheck.value;
    const safeMaxMemory = maxMemoryCheck.value;
    const safeServerPort = serverPortCheck.value;
    const safeRconPort = rconPortCheck.value;

    const quickSetupTargetServer = await resolveTargetServerForRunningCheck(installPath, {
      serverName,
      zomboidDataPath,
    });
    const quickSetupNotStoppedError = await checkSpecificServerStopped(
      req.app.get("serverManager"),
      quickSetupTargetServer,
      "running quick setup on this path",
    );
    if (quickSetupNotStoppedError) {
      return res
        .status(quickSetupNotStoppedError.status)
        .json(quickSetupNotStoppedError.body);
    }
    if (isLifecycleLockedForServer(quickSetupTargetServer)) {
      return res.status(409).json(lifecycleInProgressResponse());
    }

    const safeAdminPassword = sanitizeForBatch(adminPassword);

    log.info(
      `Quick setup: Creating server config for ${serverName} using files from ${installPath}`,
    );

    const warnings = [];

    await setSetting("serverPath", installPath);
    await setSetting("serverName", serverName);
    await setSetting("minMemory", safeMinMemory);
    await setSetting("maxMemory", safeMaxMemory);
    await setSetting("serverPort", safeServerPort);
    await setSetting("useUpnp", useUpnp);

    if (zomboidDataPath) {
      await setSetting("zomboidDataPath", zomboidDataPath);
    } else {
      await setSetting("zomboidDataPath", zomboidPath);
      log.info(
        `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
      );
    }

    await setSetting("serverConfigPath", serverConfigPath);

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (dirError: any) {
      log.error(
        `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
      );
      const writableError = formatWritablePathError("data", zomboidPath);
      const bareMetalCommand =
        writableError.code === ErrorCode.WRITABLE_PATH_DATA_BAREMETAL
          ? `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}"`
          : null;
      throw new Error(
        bareMetalCommand
          ? `${writableError.message} For example: ${bareMetalCommand}`
          : writableError.message,
      );
    }

    if (rconPassword) {
      await setSetting("rconPassword", rconPassword);
      await setSetting("rconPort", safeRconPort);
      await setSetting("rconHost", resolveEnvRconHost());

      try {
        const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
        if (!fs.existsSync(iniPath)) {
          if (!fs.existsSync(serverConfigPath)) {
            fs.mkdirSync(serverConfigPath, { recursive: true });
          }
          const safeRconPw = sanitizeIniValue(rconPassword);
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${safeRconPort}\nRCONPassword=${safeRconPw}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings at ${iniPath}`);
        }
      } catch (iniError: any) {
        log.warn(`Failed to pre-create INI: ${iniError.message}`);
        const permissionHint =
          iniError.code === "EACCES"
            ? ` ${formatWritablePathError("data", serverConfigPath).message}`
            : "";
        warnings.push({
          progressCode: ProgressCode.INSTALL_RCON_INI_PRECREATE_FAILED,
          message: `Could not pre-write the RCON password into the server config (${sanitizeError(iniError.message)}).${permissionHint} This is retried automatically the next time you start the server.`,
          params: { reason: sanitizeError(iniError.message) },
        });
      }
    }

    const scripts = generateStartupScripts({
      installPath,
      serverName,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      zomboidDataPath: zomboidPath,
      adminPassword: safeAdminPassword,
      serverPort: safeServerPort,
      useNoSteam,
      useDebug,
    });

    const batchPath = path.join(installPath, `StartServer_${serverName}.bat`);
    writeFileAtomic(batchPath, scripts.bat, "utf8");
    log.info(`Created custom startup batch: ${batchPath}`);

    const shellPath = path.join(installPath, `start-server_${serverName}.sh`);
    writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
      encoding: "utf8",
      mode: 0o750,
    });
    log.info(`Created custom startup script: ${shellPath}`);

    const startupScript =
      process.platform === "win32"
        ? `StartServer_${serverName}.bat`
        : `start-server_${serverName}.sh`;

    let panelBridgeInstalled = false;
    try {
      const possibleModPaths = [
        path.join(__dirname, "..", "..", "..", "integrations", "panelbridge", "PanelBridge"),
        path.join(path.dirname(process.execPath), "pz-mod", "PanelBridge"),
        path.join(process.cwd(), "pz-mod", "PanelBridge"),
      ];

      let modSourcePath = null;
      for (const p of possibleModPaths) {
        if (fs.existsSync(p)) {
          modSourcePath = p;
          break;
        }
      }

      if (modSourcePath) {
        const sourceLuaFile = path.join(
          modSourcePath,
          "media",
          "lua",
          "server",
          "PanelBridge.lua",
        );
        const destLuaDir = path.join(installPath, "media", "lua", "server");
        const destLuaFile = path.join(destLuaDir, "PanelBridge.lua");

        if (fs.existsSync(sourceLuaFile)) {
          if (!fs.existsSync(destLuaDir)) {
            fs.mkdirSync(destLuaDir, { recursive: true });
          }
          fs.copyFileSync(sourceLuaFile, destLuaFile);
          panelBridgeInstalled = true;
          log.info("PanelBridge mod auto-installed to server");
        }
      }
    } catch (modError: any) {
      log.warn(`Failed to auto-install PanelBridge mod: ${modError.message}`);
    }

    await logServerEventBestEffort(
      "server_quick_setup",
      `Created server config for ${serverName} using existing files at ${installPath}`,
    );

    res.json({
      success: true,
      message: "Server configuration created successfully",
      installPath,
      serverName,
      zomboidDataPath: zomboidPath, // Send back the computed data path
      serverConfigPath,
      batchFile: startupScript,
      rconPort: safeRconPort,
      hasRconPassword: !!rconPassword,
      serverPort: safeServerPort,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      panelBridgeInstalled,
      warnings,
    });
  } catch (error: any) {
    log.error(`Quick setup error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/configure-rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const { rconPassword, rconPort: rawRconPort = 27015 } = req.body || {};
    const rconPortCheck = requireIntInRange(rawRconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const rconPort = rconPortCheck.value;

    if (!rconPassword) {
      return res.status(400).json({ error: "RCON password is required", code: ErrorCode.CONFIGURE_RCON_PASSWORD_REQUIRED });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
        code: ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
        code: ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
      });
    }

    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");

      const safePassword = sanitizeIniValue(rconPassword);
      content = setIniKeyLine(content, "RCONPassword", safePassword);
      content = setIniKeyLine(content, "RCONPort", rconPort);

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });

    await setSetting("rconPassword", rconPassword);
    await setSetting("rconPort", rconPort);
    await setSetting("rconHost", resolveEnvRconHost());

    log.info(`RCON configured in ${iniPath}`);
    res.json({
      success: true,
      message: `RCON configured successfully. Restart the server for changes to take effect.`,
      iniPath,
    });
  } catch (error: any) {
    log.error(`Failed to configure RCON: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/configure-network", requirePermission("server.configure"), async (req, res) => {
  try {
    const { serverPort: rawServerPort = 16261, useUpnp = true } = req.body || {};
    const serverPortCheck = requireIntInRange(rawServerPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const serverPort = serverPortCheck.value;
    if (typeof useUpnp !== "boolean") {
      return res.status(400).json({
        error: "useUpnp must be a boolean",
      });
    }

    const serverConfigPath = await getServerConfigPath();
    const serverName = await getServerName();

    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
        code: ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
        code: ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
      });
    }

    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");

      content = setIniKeyLine(content, "DefaultPort", serverPort);
      content = setIniKeyLine(content, "UDPPort", serverPort + 1);

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });

    await applyUpnpToIni(serverConfigPath, serverName, useUpnp);

    await setSetting("serverPort", serverPort);
    await setSetting("useUpnp", useUpnp);

    log.info(
      `Network settings configured in ${iniPath}: port=${serverPort}, UPnP=${useUpnp ? "true" : "false"}`,
    );
    res.json({
      success: true,
      message: `Network settings configured successfully. Restart the server for changes to take effect.`,
      iniPath,
      settings: {
        defaultPort: serverPort,
        udpPort: serverPort + 1,
        upnp: useUpnp,
      },
    });
  } catch (error: any) {
    log.error(`Failed to configure network settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/alarm", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.alarm();
    await logServerEventBestEffort("alarm");
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to trigger alarm: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/removezombies", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.removeZombies();
    await logServerEventBestEffort("removezombies");
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to remove zombies: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/reloadlua", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { filename } = req.body || {};

    if (!filename) {
      return res.status(400).json({ error: "Filename is required", code: ErrorCode.RELOAD_LUA_FILENAME_REQUIRED });
    }

    if (!/^[a-zA-Z0-9_/.\-]+\.lua$/.test(filename) || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename format", code: ErrorCode.RELOAD_LUA_INVALID_FILENAME });
    }

    const result = await rconService.reloadLua(filename);
    await logServerEventBestEffort("reloadlua", filename);
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to reload Lua: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/log", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { type, level } = req.body || {};

    if (!type || !level) {
      return res.status(400).json({ error: "Type and level are required", code: ErrorCode.LOG_TYPE_LEVEL_REQUIRED });
    }

    const validTypes = [
      "General",
      "Network",
      "Multiplayer",
      "Voice",
      "Packet",
      "NetworkFileDebug",
      "Lua",
      "Mod",
      "Sound",
      "Zombie",
      "Combat",
      "Objects",
      "Fireplace",
      "Radio",
      "MapLoading",
      "Clothing",
      "Animation",
      "Asset",
      "Script",
      "Shader",
      "Input",
      "Recipe",
      "ActionSystem",
      "IsoRegion",
      "UniTests",
      "FileIO",
      "Ownership",
      "Death",
      "Damage",
      "Statistic",
      "Vehicle",
      "Checksum",
    ];

    const validLevels = ["Trace", "Debug", "General", "Warning", "Error"];

    if (!validTypes.includes(type)) {
      return res
        .status(400)
        .json({ error: `Invalid log type. Valid: ${validTypes.join(", ")}`, code: ErrorCode.LOG_INVALID_TYPE });
    }

    if (!validLevels.includes(level)) {
      return res
        .status(400)
        .json({ error: `Invalid log level. Valid: ${validLevels.join(", ")}`, code: ErrorCode.LOG_INVALID_LEVEL });
    }

    const result = await rconService.setLogLevel(type, level);
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to set log level: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/stats", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { mode, period } = req.body || {};

    if (!mode) {
      return res.status(400).json({ error: "Mode is required", code: ErrorCode.STATS_MODE_REQUIRED });
    }

    const validModes = ["none", "file", "console", "all"];
    if (!validModes.includes(mode.toLowerCase())) {
      return res
        .status(400)
        .json({ error: `Invalid mode. Valid: ${validModes.join(", ")}`, code: ErrorCode.STATS_INVALID_MODE });
    }

    const validPeriod = period ? coerceIntInRange(period, 1, 3600, null) : null;

    const result = await rconService.setStats(mode, validPeriod);
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to set stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/releasesafehouse", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.releaseSafehouse();
    res.json(result);
  } catch (error: any) {
    log.error(`Failed to release safehouse: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/steam-update", requirePermission("server.install"), async (req, res) => {
  let activeOperationPath = null;
  try {
    let {
      steamcmdPath,
      installPath,
      branch,
      useUnstable = false,
      validateFiles = false,
    } = req.body;

    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");

    if (!steamcmdPath) {
      steamcmdPath = await getSetting("steamcmdPath");
    }

    if (!steamcmdPath || !installPath) {
      return res
        .status(400)
        .json({ error: "Missing required fields: steamcmdPath, installPath", code: ErrorCode.STEAM_UPDATE_MISSING_FIELDS });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    const steamUpdateTargetServer = await resolveTargetServerForRunningCheck(installPath);
    const steamUpdateNotStoppedError = await checkSpecificServerStopped(
      req.app.get("serverManager"),
      steamUpdateTargetServer,
      "updating it",
      ErrorCode.STEAM_UPDATE_SERVER_RUNNING,
    );
    if (steamUpdateNotStoppedError) {
      return res
        .status(steamUpdateNotStoppedError.status)
        .json(steamUpdateNotStoppedError.body);
    }
    if (isLifecycleLockedForServer(steamUpdateTargetServer)) {
      return res.status(409).json(lifecycleInProgressResponse());
    }

    if (steamcmdDownloadInProgress) {
      return res.status(409).json({
        error: "A SteamCMD download is already in progress",
        code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
      });
    }
    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      try {
        steamcmdExe = await ensureSteamCmdInstalled(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr: any) {
        if (dlErr?.code === ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS) {
          return res.status(409).json({
            error: "A SteamCMD download is already in progress",
            code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
          });
        }
        return res.status(500).json({
          error: `SteamCMD not found and auto-download failed: ${sanitizeError(dlErr.message)}`,
          code: ErrorCode.STEAMCMD_AUTO_DOWNLOAD_FAILED,
        });
      }
    }

    try {
      const recovery = recoverMismatchedSteamBranchManifest(
        installPath,
        selectedBranch,
      );
      if (recovery) {
        log.warn(
          `Reset stale SteamCMD branch manifest (${recovery.mountedBranch} -> ${recovery.targetBranch}); backup: ${recovery.backupPath}`,
        );
      }
    } catch (error: any) {
      log.warn(`Could not inspect SteamCMD branch manifest: ${error.message}`);
    }

    try {
      const recovery = recoverBlockedSteamManifest(installPath);
      if (recovery) {
        log.warn(
          `Reset SteamCMD manifest stuck in access-denied state 0x6; backup: ${recovery.backupPath}`,
        );
      }
    } catch (error: any) {
      log.warn(`Could not reset blocked SteamCMD manifest: ${error.message}`);
    }

    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this server. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_SERVER,
      });
    }

    const operation = validateFiles ? "verification" : "update";
    log.info(`Starting PZ server ${operation} (branch: ${selectedBranch})...`);

    activeSteamOperations.set(normalizedPath, {
      type: operation,
      startTime: Date.now(),
      lastOutputAt: Date.now(),
      branch: selectedBranch,
    });
    activeOperationPath = normalizedPath;

    const betaArgs = getBetaArgs(selectedBranch);
    const loginArgs = await getSteamLoginArgs();
    const steamcmdArgs = [
      "+force_install_dir",
      installPath,
      ...loginArgs,
      "+app_update",
      "380870",
      ...betaArgs,
      "validate",
      "+quit",
    ];

    const io = req.app.get("io");

    io.emit("steam:start", {
      type: validateFiles ? "verify" : "update",
      message: validateFiles ? "Verifying game files..." : "Updating server...",
      progressCode: validateFiles
        ? ProgressCode.STEAM_START_VERIFY
        : ProgressCode.STEAM_START_UPDATE,
    });

    const updateSpawnOpts: AnyRecord = { cwd: steamcmdPath };
    if (!isWindows) {
      const ldPaths = [
        path.join(steamcmdPath, "linux32"),
        path.join(steamcmdPath, "linux64"),
        steamcmdPath,
        process.env.LD_LIBRARY_PATH || "",
      ]
        .filter(Boolean)
        .join(":");
      updateSpawnOpts.env = {
        ...buildLinuxWritableHomeEnv(steamcmdPath),
        LD_LIBRARY_PATH: ldPaths,
      };
    }
    const steamcmd = spawnProcess(steamcmdExe, steamcmdArgs, updateSpawnOpts);
    const updateOperation = activeSteamOperations.get(normalizedPath);
    if (!updateOperation) {
      throw new Error("SteamCMD operation state disappeared before update started");
    }
    updateOperation.pid = steamcmd.pid;
    const updateWatchdog = setInterval(() => {
      const activeOperation = activeSteamOperations.get(normalizedPath);
      if (!activeOperation) return;
      if (!isSteamOperationIdle(activeOperation)) return;

      log.error(
        `SteamCMD ${activeOperation.type} produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
      );
      steamcmd.kill();
    }, 30_000);
    updateOperation.watchdog = updateWatchdog;
    updateWatchdog.unref?.();

    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    steamcmd.stdout.on("data", (data: any) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stdoutBuffer += text;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "steam:log", "stdout", line);
          log.info(`SteamCMD: ${line}`);
        }
      }
    });

    steamcmd.stderr.on("data", (data: any) => {
      const operation = activeSteamOperations.get(normalizedPath);
      if (operation) operation.lastOutputAt = Date.now();
      const text = data.toString();
      output += text;
      stderrBuffer += text;

      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          emitRawSteamCmdLine(io, "steam:log", "stderr", line);
          log.warn(`SteamCMD stderr: ${line}`);
        }
      }
    });

    steamcmd.on("close", (code: any) => {
      if (stdoutBuffer.trim()) {
        emitRawSteamCmdLine(io, "steam:log", "stdout", stdoutBuffer.trim());
      }
      if (stderrBuffer.trim()) {
        emitRawSteamCmdLine(io, "steam:log", "stderr", stderrBuffer.trim());
      }

      clearActiveSteamOperation(normalizedPath);

      const success = code === 0;
      const steamDepotAccessDenied =
        /app ['"]?380870['"]? state is 0x6/i.test(output) ||
        /manifest.*access denied/i.test(output);
      const failureMessage = steamDepotAccessDenied
        ? "SteamCMD could not access a Project Zomboid depot manifest. Your installed server files were not changed. Retry later; if it persists, update using a Steam account that owns Project Zomboid."
        : `Server ${operation} failed with code ${code}`;

      let completeProgressCode;
      let completeParams;
      if (success) {
        completeProgressCode = validateFiles
          ? ProgressCode.STEAM_VERIFY_COMPLETE_SUCCESS
          : ProgressCode.STEAM_UPDATE_COMPLETE_SUCCESS;
      } else if (steamDepotAccessDenied) {
        completeProgressCode = ProgressCode.STEAM_DEPOT_ACCESS_DENIED;
      } else {
        completeProgressCode = validateFiles
          ? ProgressCode.STEAM_VERIFY_FAILED
          : ProgressCode.STEAM_UPDATE_FAILED;
        completeParams = { code };
      }

      io.emit("steam:complete", {
        success,
        message: success
          ? `Server ${operation} completed successfully`
          : failureMessage,
        progressCode: completeProgressCode,
        ...(completeParams ? { params: completeParams } : {}),
      });

      if (success) {
        try {
          const updateChecker = req.app.get("updateChecker");
          if (updateChecker) {
            setTimeout(() => updateChecker.checkForUpdates(true), 3000);
          }
        } catch (e: any) {
          // Non-critical
        }
      }

      logServerEvent(
        success ? "server_update" : "server_update_failed",
        `Server ${operation} ${success ? "completed" : "failed"}`,
      ).catch((e: any) => log.error("Failed to log server event:", e));

      log.info(`SteamCMD ${operation} finished with code ${code}`);
    });

    steamcmd.on("error", (error: any) => {
      clearActiveSteamOperation(normalizedPath);

      io.emit("steam:complete", {
        success: false,
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
        params: { reason: sanitizeError(error.message) },
      });
      log.error(`SteamCMD error: ${error.message}`);
    });

    res.json({
      success: true,
      message: `Server ${operation} started`,
    });
  } catch (error: any) {
    if (activeOperationPath) {
      activeSteamOperations.delete(activeOperationPath);
    }
    log.error(`Steam update failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/steamcmd/download", requirePermission("server.install"), async (req, res) => {
  try {
    log.info(`POST /steamcmd/download (platform=${process.platform})`);
    const defaultPath = isWindows
      ? "C:\\SteamCMD"
      : [
          "/usr/games",
          "/usr/bin",
          path.join(os.homedir(), "steamcmd"),
          "/opt/steamcmd",
          "/usr/local/bin",
        ].find(
          (p) =>
            fs.existsSync(path.join(p, "steamcmd.sh")) ||
            fs.existsSync(path.join(p, "steamcmd")),
        ) || path.join(os.homedir(), "steamcmd");
    const { installPath = defaultPath } = req.body || {};

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid installation path", code: ErrorCode.STEAMCMD_DOWNLOAD_INVALID_PATH });
    }

    if (steamcmdDownloadInProgress) {
      return res.status(409).json({
        error: "A SteamCMD download is already in progress",
        code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
      });
    }
    // Claim before the first await: the download, extraction, and first-run
    // setup continue after this handler returns and all touch installPath.
    steamcmdDownloadInProgress = true;

    const configuredSteamcmdPath = await getSetting("steamcmdPath");
    if (configuredSteamcmdPath !== installPath) {
      await setSetting("steamcmdPath", installPath);
    }

    const io = req.app.get("io");

    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }

    if (isWindows) {
      const unzipper = await import("unzipper");
      const steamcmdUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
      const zipPath = path.join(installPath, "steamcmd.zip");

      io.emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD...",
        progressCode: ProgressCode.STEAMCMD_DOWNLOADING,
      });
      log.info(`Downloading SteamCMD to ${installPath}`);

      const file = fs.createWriteStream(zipPath);

      const handleDownloadError = (err: any) => {
        file.close();
        try {
          fs.unlinkSync(zipPath);
        } catch {
          /* best effort */
        }
        steamcmdDownloadInProgress = false;
        io.emit("steamcmd:status", {
          status: "error",
          message: `Download failed: ${err.message}`,
          progressCode: ProgressCode.STEAMCMD_DOWNLOAD_FAILED,
          params: { reason: err.message },
        });
        log.error(`SteamCMD download failed: ${err.message}`);
      };

      const downloadAndExtract = (url: string | undefined) => {
        if (!url) {
          handleDownloadError(new Error("SteamCMD redirect did not include a URL"));
          return;
        }
        https
          .get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              downloadAndExtract(response.headers.location);
              return;
            }
            if (response.statusCode !== 200) {
              handleDownloadError(new Error(`HTTP ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on("close", async () => {
              try {
                await extractAndSetup(zipPath);
              } catch (unexpectedError: any) {
                log.error(`SteamCMD self-setup failed unexpectedly: ${unexpectedError.message}`);
                io.emit("steamcmd:status", {
                  status: "error",
                  message: `SteamCMD setup failed unexpectedly: ${sanitizeError(unexpectedError.message)}`,
                  progressCode: ProgressCode.STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR,
                  params: { reason: sanitizeError(unexpectedError.message) },
                });
              }
            });
          })
          .on("error", handleDownloadError);
      };

      downloadAndExtract(steamcmdUrl);

      async function extractAndSetup(zipFile: string) {
        try {
          io.emit("steamcmd:status", {
            status: "extracting",
            message: "Extracting SteamCMD...",
            progressCode: ProgressCode.STEAMCMD_EXTRACTING,
          });
          log.info("Extracting SteamCMD...");

          await fs
            .createReadStream(zipFile)
            .pipe(unzipper.default.Extract({ path: installPath }))
            .promise();

          fs.unlinkSync(zipFile);
          runFirstTimeSetup();
        } catch (extractError: any) {
          steamcmdDownloadInProgress = false;
          io.emit("steamcmd:status", {
            status: "error",
            message: `Extraction failed: ${sanitizeError(extractError.message)}`,
            progressCode: ProgressCode.STEAMCMD_EXTRACTION_FAILED,
            params: { reason: sanitizeError(extractError.message) },
          });
          log.error(`SteamCMD extraction failed: ${extractError.message}`);
        }
      }
    } else {
      const execCb = exec;
      const tarUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
      const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");

      io.emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD for Linux...",
        progressCode: ProgressCode.STEAMCMD_DOWNLOADING_LINUX,
      });
      log.info(`Downloading SteamCMD (Linux) to ${installPath}`);

      const safeTarPath = tarPath.replace(/'/g, "'\\''");
      const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
      const curlCmd = `curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`;
      const wgetCmd = `wget -q -O '${safeTarPath}' '${safeTarUrl}'`;

      const tryDownload = (cmd: string, fallbackCmd: string | null) => {
        execCb(cmd, { timeout: 120000 }, (dlErr: any) => {
          if (dlErr && fallbackCmd) {
            log.warn(
              `Download with ${cmd.split(" ")[0]} failed, trying fallback...`,
            );
            tryDownload(fallbackCmd, null);
            return;
          }
          if (dlErr) {
            steamcmdDownloadInProgress = false;
            io.emit("steamcmd:status", {
              status: "error",
              message: `Download failed: ${dlErr.message}. Ensure curl or wget is installed.`,
              progressCode: ProgressCode.STEAMCMD_DOWNLOAD_FAILED_LINUX,
              params: { reason: dlErr.message },
            });
            log.error(`SteamCMD download failed: ${dlErr.message}`);
            return;
          }
          afterDownload();
        });
      };

      tryDownload(curlCmd, wgetCmd);

      function afterDownload() {
        io.emit("steamcmd:status", {
          status: "extracting",
          message: "Extracting SteamCMD...",
          progressCode: ProgressCode.STEAMCMD_EXTRACTING,
        });
        log.info("Extracting SteamCMD...");

        const safeInstallPath = installPath.replace(/'/g, "'\\''");
        execCb(
          `tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`,
          { timeout: 30000 },
          (tarErr) => {
            try {
              fs.unlinkSync(tarPath);
            } catch (e: any) {
              /* ignore */
            }
            if (tarErr) {
              steamcmdDownloadInProgress = false;
              io.emit("steamcmd:status", {
                status: "error",
                message: `Extraction failed: ${tarErr.message}`,
                progressCode: ProgressCode.STEAMCMD_EXTRACTION_FAILED,
                params: { reason: tarErr.message },
              });
              log.error(`SteamCMD extraction failed: ${tarErr.message}`);
              return;
            }

            const steamcmdSh = path.join(installPath, "steamcmd.sh");
            try {
              fs.chmodSync(steamcmdSh, 0o755);
            } catch (e: any) {
              /* ignore */
            }
            const steamcmdBin = path.join(installPath, "steamcmd");
            try {
              fs.chmodSync(steamcmdBin, 0o755);
            } catch (e: any) {
              /* ignore */
            }

            log.info(
              "Checking for required 32-bit libraries (SteamCMD dependency)...",
            );
            execCb(
              "ldconfig -p | grep -c libc.so.6",
              { timeout: 5000 },
              (ldErr) => {
                if (ldErr) {
                  log.warn(
                    "Could not verify 32-bit libraries. SteamCMD may fail if glibc.i686 / lib32gcc is not installed.",
                  );
                  io.emit("steamcmd:log", {
                    type: "stderr",
                    text: "Warning: Could not verify 32-bit libraries. If SteamCMD fails, install: yum install glibc.i686 libstdc++.i686 (CentOS/RHEL) or apt install lib32gcc-s1 (Debian/Ubuntu)",
                    progressCode: ProgressCode.STEAMCMD_32BIT_LIB_WARNING,
                  });
                }
                runFirstTimeSetup();
              },
            );
          },
        );
      }
    }

    function runFirstTimeSetup() {
      return runSteamCmdFirstTimeSetup(
        getSteamCmdExe(installPath),
        installPath,
        io,
      ).catch((error: any) => {
        log.error(`SteamCMD first-run failed unexpectedly: ${error.message}`);
      }).finally(() => {
        steamcmdDownloadInProgress = false;
      });
    }

    res.json({ success: true, message: "SteamCMD download started" });
  } catch (error: any) {
    steamcmdDownloadInProgress = false;
    log.error(`SteamCMD download failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/steamcmd/check", requirePermission("server.install"), async (req, res) => {
  try {
    const checkPath =
      typeof req.query.path === "string" ? req.query.path : null;

    if (!checkPath || !isValidPath(checkPath)) {
      return res.json({ exists: false, message: "Invalid path" });
    }

    const steamcmdExe = getSteamCmdExe(checkPath);
    const exists = fs.existsSync(steamcmdExe);

    res.json({
      exists,
      path: checkPath,
      executable: steamcmdExe,
      message: exists
        ? "SteamCMD found"
        : "SteamCMD not found at this location",
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

async function checkSpecificServerStopped(
  serverManager: any,
  targetServer: AnyRecord,
  actionLabel: string,
  runningCode: string = ErrorCode.WIPE_SERVER_RUNNING,
) {
  const provider = String(targetServer.lifecycleProvider || "");
  if (isManagedLifecycleProvider(provider)) {
    try {
      const status = await createLinuxServiceLifecycle(
        targetServer as Parameters<typeof createLinuxServiceLifecycle>[0],
        provider,
      ).status();
      if (status.scanFailed) {
        return {
          status: 503,
          body: {
            error:
              "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error.",
            code: ErrorCode.SERVER_STATE_UNKNOWN,
          },
        };
      }
      if (status.running) {
        return {
          status: 400,
          body: {
            error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
            code: runningCode,
          },
        };
      }
      return null;
    } catch (error: unknown) {
      return {
        status: 503,
        body: {
          error: `Can't verify whether the server is actually stopped — ${error instanceof Error ? error.message : String(error)}`,
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        },
      };
    }
  }

  const usesRawProcessScan =
    typeof serverManager?._scanDedicatedServerProcesses === "function";
  let processDetails: AnyRecord;
  try {
    processDetails = usesRawProcessScan
      ? await serverManager._scanDedicatedServerProcesses()
      : await serverManager.getServerProcessDetails();
  } catch (error: unknown) {
    return {
      status: 503,
      body: {
        error: `Can't verify whether the server is actually stopped — ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  if (processDetails.scanFailed) {
    return {
      status: 503,
      body: {
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  if (!usesRawProcessScan) {
    if (processDetails.running) {
      return {
        status: 400,
        body: {
          error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
          code: runningCode,
        },
      };
    }
    return null;
  }

  let owned = false;
  let unattributable = false;
  const descriptor = {
    serverName: targetServer.serverName || targetServer.name,
    savePath: targetServer.zomboidDataPath,
    serverPath: targetServer.serverPath || targetServer.installPath,
  };
  for (const entry of Array.isArray(processDetails.matched)
    ? processDetails.matched
    : []) {
    const score = scoreServerProcessOwnership(entry.cmd, descriptor);
    if (score > 0) owned = true;
    else if (score === 0) unattributable = true;
  }

  if (owned) {
    return {
      status: 400,
      body: {
        error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
        code: runningCode,
      },
    };
  }
  if (unattributable) {
    return {
      status: 503,
      body: {
        error:
          "Can't verify whether the server is actually stopped — a dedicated PZ server process exists on this host that can't be confirmed to belong to a different server. Check the panel's log for the process, or stop it and try again.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  return null;
}

async function resolveTargetServerForRunningCheck(
  installPath: string,
  fallback: AnyRecord = {},
): Promise<AnyRecord> {
  const configuredServers =
    typeof getServers === "function" ? await getServers() : [];
  const resolvedPath = path.resolve(installPath);
  const matchedServer = (Array.isArray(configuredServers)
    ? configuredServers
    : []
  ).find(
    (server: AnyRecord) =>
      server.installPath && path.resolve(server.installPath) === resolvedPath,
  );
  return (
    matchedServer || {
      ...fallback,
      installPath,
    }
  );
}

router.post("/delete-files", requirePermission("server.wipe"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock("delete-files");
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }

  try {
    const serverManager = req.app.get("serverManager");

    const { path: deletePath, confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: "Deleting these files requires confirm: true",
        code: ErrorCode.DELETE_FILES_CONFIRM_REQUIRED,
      });
    }

    if (!deletePath || !isValidPath(deletePath)) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    if (!fs.existsSync(deletePath)) {
      return res.status(404).json({ error: "Path does not exist", code: ErrorCode.PATH_NOT_FOUND });
    }

    const hasPzFiles = hasPzInstallMarker(deletePath);

    const normalizedDelete = path.normalize(deletePath);
    if (normalizedDelete.includes("..")) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    if (!hasPzFiles) {
      return res.status(400).json({
        error:
          "This does not appear to be a Project Zomboid server installation. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_PZ_INSTALL,
      });
    }

    const resolvedDeletePath = path.resolve(deletePath);
    const configuredServers = (await getServers()) as AnyRecord[];
    const targetServer = configuredServers.find(
      (s) => s.installPath && path.resolve(s.installPath) === resolvedDeletePath,
    );
    if (!targetServer) {
      return res.status(400).json({
        error:
          "This path doesn't match a server the panel has on record. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_CONFIGURED_SERVER,
      });
    }

    const normalizedDeleteTargetPath = path
      .normalize(deletePath)
      .toLowerCase();
    if (hasActiveSteamOperation(normalizedDeleteTargetPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
      });
    }

    const zomboidDataPath = targetServer.zomboidDataPath;
    if (zomboidDataPath) {
      const resolvedDeletePath = path.resolve(deletePath);
      if (confineToRoots(zomboidDataPath, [resolvedDeletePath])) {
        return res.status(400).json({
          error: `Refusing to delete: this server's Zomboid data folder (${zomboidDataPath}) is inside the folder you're about to delete, so this would also permanently destroy the world save. Move the data path outside the install folder in Settings, or back it up yourself first, before deleting.`,
          code: ErrorCode.DELETE_FILES_DATA_PATH_NESTED,
        });
      }
    }

    const notStoppedError = await checkSpecificServerStopped(
      serverManager,
      targetServer,
      "deleting its files",
    );
    if (notStoppedError) {
      return res.status(notStoppedError.status).json(notStoppedError.body);
    }

    const stillNotStoppedError = await checkSpecificServerStopped(
      serverManager,
      targetServer,
      "deleting its files",
    );
    if (stillNotStoppedError) {
      return res.status(stillNotStoppedError.status).json(stillNotStoppedError.body);
    }

    log.warn(`Deleting server files at: ${deletePath}`);

    fs.rmSync(deletePath, { recursive: true, force: true });

    log.info(`Successfully deleted server files at: ${deletePath}`);
    res.json({ success: true, message: "Server files deleted" });
  } catch (error: any) {
    log.error(`Failed to delete server files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

router.post("/list-directory", requirePermission("server.install"), async (req, res) => {
  try {
    const { dirPath } = req.body || {};

    if (!dirPath) {
      if (isWindows) {
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drivePath = `${letter}:\\`;
          try {
            fs.accessSync(drivePath, fs.constants.R_OK);
            let label = `Local Disk (${letter}:)`;
            try {
              const stats = fs.statfsSync(drivePath);
              const totalGB = (
                (stats.bsize * stats.blocks) /
                1024 ** 3
              ).toFixed(1);
              const freeGB = ((stats.bsize * stats.bfree) / 1024 ** 3).toFixed(
                1,
              );
              label = `${letter}: — ${freeGB} GB free of ${totalGB} GB`;
            } catch (e: any) {
              log.debug(`Drive stat failed for ${letter}: ${e.message}`);
            }
            drives.push({
              name: `${letter}:`,
              path: drivePath,
              label,
              isDrive: true,
            });
          } catch (e: any) {
            // Drive not accessible
          }
        }
        return res.json({
          entries: drives,
          currentPath: null,
          parentPath: null,
        });
      } else {
        return res.json({
          entries: [{ name: "/", path: "/", label: "/", isDrive: true }],
          currentPath: null,
          parentPath: null,
        });
      }
    }

    if (!isValidPath(dirPath)) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    const normalized = path.normalize(dirPath);

    if (!fs.existsSync(normalized)) {
      return res.status(404).json({ error: "Path does not exist", code: ErrorCode.PATH_NOT_FOUND });
    }

    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory", code: ErrorCode.PATH_NOT_A_DIRECTORY });
    }

    let items;
    try {
      items = fs.readdirSync(normalized, { withFileTypes: true });
    } catch (e: any) {
      const osCode = e && typeof e === "object" && "code" in e ? e.code : "UNKNOWN";
      const readError = formatDirectoryReadError(normalized, osCode);
      return res.status(403).json({
        error: readError.message,
        code: readError.code,
        params: readError.params,
      });
    }

    const folders = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (
        item.name.startsWith(".") ||
        item.name === "$RECYCLE.BIN" ||
        item.name === "System Volume Information"
      )
        continue;
      folders.push({
        name: item.name,
        path: path.join(normalized, item.name),
      });
    }

    folders.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    const parentPath = path.dirname(normalized);
    const hasParent = parentPath !== normalized;

    res.json({
      entries: folders,
      currentPath: normalized,
      parentPath: hasParent ? parentPath : null,
    });
  } catch (error: any) {
    log.error(`List directory failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/browse-folder", requirePermission("server.install"), async (req, res) => {
  try {
    const { initialPath, description = "Select a folder" } = req.body || {};

    if (
      typeof description !== "string" ||
      description.length > 100 ||
      !/^[a-zA-Z0-9 _.\-:()]+$/.test(description)
    ) {
      return res.status(400).json({ error: "Invalid description parameter", code: ErrorCode.BROWSE_FOLDER_INVALID_DESCRIPTION });
    }

    if (!isWindows) {
      const execCb = exec;
      const safeDesc = description.replace(/'/g, "'\\''");
      const safePath =
        initialPath && isValidPath(initialPath)
          ? initialPath.replace(/'/g, "'\\''")
          : "";

      const zenityCmd = `zenity --file-selection --directory --title='${safeDesc}'${safePath ? ` --filename='${safePath}/'` : ""}`;
      execCb(zenityCmd, { timeout: 120000 }, (zenErr, zenOut) => {
        if (!zenErr && zenOut && zenOut.trim()) {
          return res.json({
            success: true,
            path: zenOut.trim(),
            cancelled: false,
          });
        }
        if (zenErr && zenErr.code === 1) {
          return res.json({ success: false, path: null, cancelled: true });
        }
        const kdialogCmd = `kdialog --getexistingdirectory '${safePath || "~"}' --title '${safeDesc}'`;
        execCb(kdialogCmd, { timeout: 120000 }, (kdErr, kdOut) => {
          if (!kdErr && kdOut && kdOut.trim()) {
            return res.json({
              success: true,
              path: kdOut.trim(),
              cancelled: false,
            });
          }
          if (kdErr && kdErr.code === 1) {
            return res.json({ success: false, path: null, cancelled: true });
          }
          return res.status(501).json({
            error:
              "No folder browser available. Install zenity or kdialog, or enter the path manually.",
            code: ErrorCode.BROWSE_FOLDER_NO_DIALOG_AVAILABLE,
          });
        });
      });
      return;
    }

    const safePath =
      initialPath && isValidPath(initialPath)
        ? initialPath.replace(/'/g, "''")
        : "";
    const safeDesc = description.replace(/'/g, "''");

    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${safeDesc}'
$dialog.UseDescriptionForTitle = $true
$dialog.ShowNewFolderButton = $true
${safePath ? `if (Test-Path '${safePath}') { $dialog.SelectedPath = '${safePath}' }` : ""}
$result = $dialog.ShowDialog()
if ($result -eq 'OK') { Write-Output $dialog.SelectedPath } else { Write-Output '' }
`;

    const powershell = spawnProcess(
      "powershell",
      ["-NoProfile", "-STA", "-Command", psScript],
      {
        windowsHide: false,
      },
    );

    let output = "";
    let errorOutput = "";

    powershell.stdout.on("data", (data: any) => {
      output += data.toString();
    });

    powershell.stderr.on("data", (data: any) => {
      errorOutput += data.toString();
    });

    powershell.on("close", (code: any) => {
      const selectedPath = output.trim();

      if (code !== 0 || errorOutput) {
        log.warn(`Folder browser had issues: ${errorOutput}`);
      }

      res.json({
        success: !!selectedPath,
        path: selectedPath || null,
        cancelled: !selectedPath,
      });
    });

    powershell.on("error", (error: any) => {
      log.error(`Folder browser error: ${error.message}`);
      res.status(500).json({ error: "Failed to open folder browser", code: ErrorCode.BROWSE_FOLDER_OPEN_FAILED });
    });
  } catch (error: any) {
    log.error(`Browse folder failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


const CONSOLE_LOG_EXCLUDE_PATTERNS = [
  // Duplicate sprites/textures (very spammy)
  /IsoSpriteManager\.AddSprite > duplicate texture/,
  // PlayerHitZombie packet spam (not consistent packets)
  /The packet PlayerHitZombie is not consistent/,
  // Missing icons for build items (cosmetic only)
  /XuiSkin\$EntityUiStyle\.Load > Could not find icon:/,
  /XuiSkin\$EntityUiStyle\.LoadComponentInfo> Could not find icon:/,
  // Recursive require warnings (usually harmless)
  /LuaManager\.RunLua > recursive require\(\)/,
  // AnimalPacket/AnimalEventPacket class warnings (known issue)
  /The AnimalPacket class doesn't have PacketSetting attributes/,
  /The AnimalEventPacket class doesn't have PacketSetting attributes/,
];

const CONSOLE_LOG_ERROR_PATTERNS = [
  /^ERROR\[/,
  /Exception thrown/,
  /Stack trace:/,
  /java\.lang\.\w+Exception/,
  /KahluaThread\.flushErrorMessage/,
];

const CONSOLE_LOG_IMPORTANT_PATTERNS = [
  /^\[PanelBridge\]/,
  /SERVER STARTED/,
  /fully-connected/,
  /player-connect/,
  /connection-lost/,
  /disconnect/,
  /Steam client .* is initiating/,
  /RCON:/,
  /Recipe AutoLearned/,
  /Reduce Head Condition/,
  /ISBuildIsoEntity/,
];

function filterConsoleLogLines(lines: string[], filterLevel = "filtered") {
  if (filterLevel === "all") {
    return lines;
  }

  return lines.filter((line) => {
    if (!line.trim()) return false;

    const isError = CONSOLE_LOG_ERROR_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isError) return true;

    const isImportant = CONSOLE_LOG_IMPORTANT_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isImportant) return true;

    if (filterLevel === "errors") {
      return isError;
    }

    if (filterLevel === "important") {
      return isError || isImportant;
    }

    const isNoise = CONSOLE_LOG_EXCLUDE_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    return !isNoise;
  });
}

router.get("/console-log", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({
        success: true,
        content: "",
        lines: [],
        exists: false,
        path: consoleLogPath,
      });
    }

    const filterLevel =
      typeof req.query.filter === "string" ? req.query.filter : "filtered";

    const maxLines = parseBoundedInteger(req.query.lines, 500, 1, 2000);

    const stats = fs.statSync(consoleLogPath);
    const MAX_READ_BYTES = 5 * 1024 * 1024;
    let content;
    if (stats.size > MAX_READ_BYTES) {
      const fd = fs.openSync(consoleLogPath, "r");
      const readStart = stats.size - MAX_READ_BYTES;
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, readStart);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_: any) {
          /* ignore */
        }
      }
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }
    const allLines = content.split("\n");

    const filteredLines = filterConsoleLogLines(allLines, filterLevel);
    const lines = filteredLines.slice(-maxLines);

    res.json({
      success: true,
      content: lines.join("\n"),
      lines,
      totalLines: allLines.length,
      filteredCount: filteredLines.length,
      filterLevel,
      exists: true,
      path: consoleLogPath,
      lastModified: stats.mtime.toISOString(),
      size: stats.size,
    });
  } catch (error: any) {
    log.error(`Failed to read server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

let errorCountCache: { at: number; value: AnyRecord | null } = {
  at: 0,
  value: null,
};
const ERROR_COUNT_TTL_MS = 20000;

router.get("/console-log/error-count", requirePermission("server.world_events"), async (req, res) => {
  try {
    const now = Date.now();
    if (errorCountCache.value && now - errorCountCache.at < ERROR_COUNT_TTL_MS) {
      return res.json(errorCountCache.value);
    }

    const activeServer = await getActiveServer();
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");
    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    const MAX_READ_BYTES = 2 * 1024 * 1024;
    const stats = fs.statSync(consoleLogPath);
    let content;
    let truncated = false;
    if (stats.size > MAX_READ_BYTES) {
      truncated = true;
      const fd = fs.openSync(consoleLogPath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, stats.size - MAX_READ_BYTES);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_: any) {
          /* ignore */
        }
      }
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }

    const lines = content.split("\n");
    let startIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/SERVER STARTED/.test(lines[i])) {
        startIndex = i;
        break;
      }
    }
    const scanned = startIndex >= 0 ? lines.slice(startIndex) : lines;
    const count = scanned.filter((line) =>
      CONSOLE_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line)),
    ).length;

    const payload = {
      exists: true,
      count,
      sinceStart: startIndex >= 0,
      truncated,
      lastModified: stats.mtime.toISOString(),
    };
    errorCountCache = { at: now, value: payload };
    res.json(payload);
  } catch (error: any) {
    log.error(`Failed to count console log errors: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/console-log/stream", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ success: true, newLines: [], exists: false });
    }

    const filterLevel =
      typeof req.query.filter === "string" ? req.query.filter : "filtered";

    const lastSize = parseBoundedInteger(
      req.query.lastSize,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const stats = fs.statSync(consoleLogPath);

    if (stats.size < lastSize) {
      const content = fs.readFileSync(consoleLogPath, "utf-8");
      const allLines = content.split("\n").filter((l) => l.trim());
      const lines = filterConsoleLogLines(allLines, filterLevel);
      return res.json({
        success: true,
        newLines: lines,
        currentSize: stats.size,
        rotated: true,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    if (stats.size === lastSize) {
      return res.json({
        success: true,
        newLines: [],
        currentSize: stats.size,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    const fd = fs.openSync(consoleLogPath, "r");
    const newBytes = stats.size - lastSize;
    const buffer = Buffer.alloc(newBytes);
    try {
      fs.readSync(fd, buffer, 0, newBytes, lastSize);
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_: any) {
        /* ignore */
      }
    }

    const newContent = buffer.toString("utf-8");
    const allNewLines = newContent.split("\n").filter((l) => l.trim());
    const newLines = filterConsoleLogLines(allNewLines, filterLevel);

    res.json({
      success: true,
      newLines,
      currentSize: stats.size,
      filterLevel,
      lastModified: stats.mtime.toISOString(),
    });
  } catch (error: any) {
    log.error(`Failed to stream server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/console-log/clear", requirePermission("server.configure"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const zomboidDataPath =
      activeServer?.zomboidDataPath ||
      activeServer?.installPath ||
      (await getSetting("zomboidDataPath")) ||
      (await getSetting("serverPath"));

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (fs.existsSync(consoleLogPath)) {
      fs.writeFileSync(consoleLogPath, "");
      log.info("Server console log cleared");
    }

    res.json({ success: true });
  } catch (error: any) {
    log.error(`Failed to clear server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


router.get("/update-check", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    const forceCheck = req.query.force === "true";

    if (forceCheck) {
      const result = await updateChecker.checkForUpdates(true);
      res.json(result || { error: "Could not check for updates", code: ErrorCode.UPDATE_CHECK_NO_RESULT });
    } else {
      res.json(await updateChecker.getStatus());
    }
  } catch (error: any) {
    log.error(`Update check failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/update-check/status", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    res.json(await updateChecker.getStatus());
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/update-check/auto-update-result/dismiss", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    await updateChecker.dismissAutoUpdateResult();
    res.json(await updateChecker.getStatus());
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/update-check/interval", requirePermission("server.configure"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    const { minutes } = req.body || {};
    if (!minutes || typeof minutes !== "number") {
      return res.status(400).json({ error: "minutes must be a number", code: ErrorCode.UPDATE_CHECK_INTERVAL_INVALID });
    }

    await updateChecker.setInterval(minutes);
    res.json({ success: true, intervalMinutes: minutes });
  } catch (error: any) {
    log.error(`Failed to set update check interval: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});


let wipeInProgress = false;

const WIPE_PREVIEW_WALK_CONCURRENCY = 8;
async function runWithConcurrencyBounded(items: any[], limit: number, worker: any) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function countDir(dir: string, budget: any) {
  if (budget.truncated || Date.now() >= budget.deadline || budget.visited >= budget.maxEntries) {
    budget.truncated = true;
    return { files: 0, size: 0 };
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e: any) {
    log.debug(`countDir readdir failed for ${dir}: ${e.message}`);
    return { files: 0, size: 0 };
  }
  const results = await runWithConcurrencyBounded(
    entries,
    WIPE_PREVIEW_WALK_CONCURRENCY,
    async (entry: fs.Dirent) => {
      if (budget.truncated || Date.now() >= budget.deadline || budget.visited >= budget.maxEntries) {
        budget.truncated = true;
        return { files: 0, size: 0 };
      }
      budget.visited++;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return countDir(fullPath, budget);
      }
      let size = 0;
      try {
        const stat = await fs.promises.stat(fullPath);
        size = stat.size;
      } catch (e: any) {
        log.debug(`Stat failed for ${fullPath}: ${e.message}`);
      }
      return { files: 1, size };
    },
  );
  let files = 0;
  let size = 0;
  for (const r of results) {
    files += r.files;
    size += r.size;
  }
  return { files, size };
}

router.post("/wipe/preview", requirePermission("server.wipe"), async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(400).json({
        error: "No active server configured",
        code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED,
      });
    }
    try {
      await serverManager.reloadConfig();
    } catch (error: unknown) {
      return res.status(503).json({
        error:
          "Could not verify the active server's configuration — refusing to preview a wipe against possibly-stale state. Try again, or restart the panel.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }

    const { targets } = req.body || {};
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
        code: ErrorCode.WIPE_TARGETS_REQUIRED,
      });
    }

    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Invalid targets: ${invalid.join(", ")}. Allowed: ${allowedTargets.join(", ")}`,
        code: ErrorCode.WIPE_PREVIEW_INVALID_TARGETS,
      });
    }
    const savePath = activeServer.zomboidDataPath;
    const serverName = activeServer.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }

    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name", code: ErrorCode.WIPE_INVALID_SERVER_NAME });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}`, code: ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND });
    }

    const preview: AnyRecord = {};
    let totalFiles = 0;
    let totalSize = 0;
    const budget = {
      deadline: Date.now() + 15_000,
      visited: 0,
      maxEntries: 300_000,
      truncated: false,
    };

    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    if (targets.includes("map")) {
      let mapFiles = 0;
      let mapSize = 0;
      for (const dirName of MAP_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = await countDir(dir, budget);
          mapFiles += sub.files;
          mapSize += sub.size;
        }
      }
      preview.map = { files: mapFiles, size: mapSize };
      totalFiles += mapFiles;
      totalSize += mapSize;
    }

    if (targets.includes("players")) {
      let playerFiles = 0;
      let playerSize = 0;
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            playerFiles++;
            try {
              playerSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e: any) {
              log.debug(
                `Stat failed for player file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e: any) {
        log.debug(`Player file scan failed: ${e.message}`);
      }
      preview.players = { files: playerFiles, size: playerSize };
      totalFiles += playerFiles;
      totalSize += playerSize;
    }

    if (targets.includes("world")) {
      let worldFiles = 0;
      let worldSize = 0;
      for (const dirName of WORLD_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = await countDir(dir, budget);
          worldFiles += sub.files;
          worldSize += sub.size;
        }
      }
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            worldFiles++;
            try {
              worldSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e: any) {
              log.debug(
                `Stat failed for world file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e: any) {
        log.debug(`World file scan failed: ${e.message}`);
      }
      preview.world = { files: worldFiles, size: worldSize };
      totalFiles += worldFiles;
      totalSize += worldSize;
    }

    if (SAVE_TARGETS.every((t) => targets.includes(t))) {
      const claimed = new Set([...MAP_DIRS, ...WORLD_DIRS]);
      let extraFiles = 0;
      let extraSize = 0;
      try {
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          if (claimed.has(entry.name)) continue;
          if (
            !entry.isDirectory() &&
            (PLAYER_ROOT_FILES.test(entry.name) ||
              WORLD_ROOT_FILES.test(entry.name))
          ) {
            continue;
          }
          const fullPath = path.join(saveDir, entry.name);
          if (entry.isDirectory()) {
            const sub = await countDir(fullPath, budget);
            extraFiles += sub.files;
            extraSize += sub.size;
          } else {
            extraFiles++;
            try {
              extraSize += fs.statSync(fullPath).size;
            } catch (e: any) {
              log.debug(`Stat failed for ${entry.name}: ${e.message}`);
            }
          }
        }
      } catch (e: any) {
        log.debug(`Leftover scan failed: ${e.message}`);
      }
      preview.leftovers = { files: extraFiles, size: extraSize };
      totalFiles += extraFiles;
      totalSize += extraSize;
    }

    if (targets.includes("accounts")) {
      let accountFiles = 0;
      let accountSize = 0;
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
        if (fs.existsSync(dbFile)) {
          accountFiles++;
          try {
            accountSize += fs.statSync(dbFile).size;
          } catch (e: any) {
            log.debug(`Stat failed for ${dbFile}: ${e.message}`);
          }
        }
      }
      preview.accounts = { files: accountFiles, size: accountSize };
      totalFiles += accountFiles;
      totalSize += accountSize;
    }

    res.json({
      success: true,
      serverName,
      saveDir,
      targets,
      preview,
      totalFiles,
      totalSize,
      truncated: budget.truncated,
    });
  } catch (error: any) {
    log.error(`Wipe preview failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/wipe", requirePermission("server.wipe"), async (req, res) => {
  if (wipeInProgress) {
    return res.status(409).json({
      error: "A wipe operation is already in progress. Please wait.",
      code: ErrorCode.WIPE_IN_PROGRESS,
    });
  }
  wipeInProgress = true;

  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "wipe",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    wipeInProgress = false;
    return res.status(409).json(lifecycleInProgressResponse());
  }

  let serverName = null;
  let backupResult = null;
  let results: AnyRecord = {};
  let targets: string[] | null = null;

  try {
    const serverManager = req.app.get("serverManager");
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(400).json({
        error: "No active server configured",
        code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED,
      });
    }
    try {
      await serverManager.reloadConfig();
    } catch (error: unknown) {
      return res.status(503).json({
        error:
          "Could not verify the active server's configuration — refusing to wipe against possibly-stale state. Nothing was deleted. Try again, or restart the panel.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }

    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (processDetails.running) {
      return res.status(400).json({
        error: "Server must be stopped before wiping. Stop the server first.",
        code: ErrorCode.WIPE_SERVER_RUNNING,
      });
    }

    let confirm, createBackup;
    const requestedTargets = req.body?.targets;
    ({ confirm, createBackup = true } = req.body || {});
    targets = requestedTargets as string[];
    if (confirm !== true) {
      return res.status(400).json({ error: "Wipe requires confirm: true", code: ErrorCode.WIPE_CONFIRM_REQUIRED });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
        code: ErrorCode.WIPE_TARGETS_REQUIRED,
      });
    }

    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res
        .status(400)
        .json({ error: `Invalid targets: ${invalid.join(", ")}`, code: ErrorCode.WIPE_INVALID_TARGETS });
    }
    const wipeTargets = targets;

    const savePath = activeServer.zomboidDataPath;
    serverName = activeServer.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }

    if (
      serverManager.serverPath &&
      confineToRoots(savePath, [path.resolve(serverManager.serverPath)]) &&
      hasActiveSteamOperation(
        path.normalize(serverManager.serverPath).toLowerCase(),
      )
    ) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
      });
    }

    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name", code: ErrorCode.WIPE_INVALID_SERVER_NAME });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}`, code: ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND });
    }

    const normalizedSaveDir = path.normalize(saveDir);
    if (normalizedSaveDir.includes("..")) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    if (createBackup) {
      const backupService = req.app.get("backupService");
      if (!backupService) {
        return res.status(500).json({
          error: "Backup service unavailable — refusing to wipe without a backup. Nothing was deleted.",
          code: ErrorCode.WIPE_BACKUP_FAILED,
        });
      }
      const io = req.app.get("io");
      backupResult = await backupService.createBackup({
        isPreWipe: true,
        io,
        activeServer,
      });
      const backupIncomplete =
        backupResult.success && (backupResult.skippedFiles?.length ?? 0) > 0;
      if (!backupResult.success || backupIncomplete) {
        const reason = backupIncomplete
          ? `it could not include ${backupResult.skippedFiles.length} file(s) (${backupResult.skippedFiles.join(", ")}) -- an incomplete pre-wipe backup is not a safety net`
          : backupResult.message;
        return res.status(500).json({
          error: `Wipe aborted: could not create a backup first (${reason}). Nothing was deleted.`,
          code: ErrorCode.WIPE_BACKUP_FAILED,
        });
      }

      if (targets.includes("accounts")) {
        try {
          const accountsBackupDir = path.join(
            await backupService.getBackupsPath(activeServer),
            `${serverName}_accounts_${Date.now()}`,
          );
          await fs.promises.mkdir(accountsBackupDir, { recursive: true });
          for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
            if (fs.existsSync(dbFile)) {
              await fs.promises.copyFile(
                dbFile,
                path.join(accountsBackupDir, `${serverName}.db${suffix}`),
              );
            }
          }
        } catch (e: any) {
          return res.status(500).json({
            error: `Wipe aborted: could not back up the accounts database (${e.message}). Nothing was deleted.`,
            code: ErrorCode.WIPE_BACKUP_FAILED,
          });
        }
      }
    }

    results = {};

    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    try {
      if (targets.includes("map")) {
        let deletedCount = 0;
        for (const dirName of MAP_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        results.map =
          deletedCount > 0
            ? `deleted ${deletedCount} directories`
            : "not found";
        invalidateMapFolderScan(path.join(saveDir, "map"));
      }

      if (targets.includes("players")) {
        let deletedCount = 0;
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            log.warn(`WIPE: Deleting player file ${entry.name}`);
            fs.unlinkSync(path.join(saveDir, entry.name));
            deletedCount++;
          }
        }
        results.players =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }

      if (targets.includes("world")) {
        let deletedCount = 0;
        for (const dirName of WORLD_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            log.warn(`WIPE: Deleting world file ${entry.name}`);
            fs.unlinkSync(path.join(saveDir, entry.name));
            deletedCount++;
          }
        }
        results.world =
          deletedCount > 0 ? `deleted ${deletedCount} items` : "not found";
      }

      if (SAVE_TARGETS.every((t) => wipeTargets.includes(t))) {
        let leftovers = 0;
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          log.warn(`WIPE: Deleting leftover ${entry.name}`);
          fs.rmSync(path.join(saveDir, entry.name), {
            recursive: true,
            force: true,
          });
          leftovers++;
        }
        results.leftovers =
          leftovers > 0 ? `deleted ${leftovers} remaining items` : "none";
      }

      if (targets.includes("accounts")) {
        let deletedCount = 0;
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
          if (fs.existsSync(dbFile)) {
            log.warn(`WIPE: Deleting account database ${dbFile}`);
            fs.rmSync(dbFile, { force: true });
            deletedCount++;
          }
        }
        results.accounts =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }
    } finally {
      wipeInProgress = false;
    }

    log.warn(
      `WIPE COMPLETE: server=${serverName}, targets=${targets.join(",")}, results=${JSON.stringify(results)}`,
    );
    await logServerEventBestEffort("wipe", `Server wiped: ${targets.join(", ")}`, {
      targets,
      results,
    });

    res.json({
      success: true,
      serverName,
      targets,
      results,
      backupCreated: !!backupResult?.success,
      backupName: backupResult?.backup?.name || null,
      message: `Server "${serverName}" wiped: ${targets.join(", ")}`,
    });
  } catch (error: any) {
    log.error(`Wipe failed: ${error.message}`);
    log.warn(`WIPE PARTIAL: server=${serverName || "unknown"}, results=${JSON.stringify(results)}`);
    await logServerEventBestEffort(
      "wipe",
      `Server wipe FAILED partway through: ${error.message}`,
      { targets, results, error: error.message },
    );
    res.status(500).json({
      error: `Wipe failed partway through (${sanitizeError(error.message)}). Some of the selected targets may be only partially deleted -- check the results for what completed before the failure.`,
      code: ErrorCode.WIPE_PARTIAL_FAILURE,
      params: { reason: sanitizeError(error.message) },
      results,
      backupCreated: !!backupResult?.success,
      backupName: backupResult?.backup?.name || null,
    });
  } finally {
    wipeInProgress = false;
    lifecycleLock.release();
  }
});

export default router;

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
import { resolveLaunchMode } from "../services/serverManager.ts";
import {
  isSteamOperationIdle,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  hasActiveSteamOperation,
  STEAM_OPERATION_IDLE_TIMEOUT_MS,
} from "../services/activeSteamOperations.ts";
import { normalizeMemoryGb } from "../utils/memory.ts";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.ts";
import { requirePermission } from "../services/permissions.ts";
import { runManagedLifecycle } from "../services/managedContainer.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { ProgressCode } from "../utils/progressCodes.ts";
import { invalidateMapFolderScan } from "./chunks.ts";
import { emitActionResult } from "./scheduler.ts";
import { autoInstallBridgeIfNeeded } from "../services/panelBridgeInstaller.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import { confineToRoots } from "../utils/browseRoots.ts";
import { isContainerized } from "../utils/dockerDetect.ts";

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

  emit("steamcmd:status", {
    status: "initializing",
    message: "Initializing SteamCMD (first run)...",
    progressCode: ProgressCode.STEAMCMD_INITIALIZING,
  });
  if (!steamcmdExe) {
    throw new Error("SteamCMD executable path is unavailable after download");
  }
  const ldPaths = [
    path.join(installPath, "linux32"),
    path.join(installPath, "linux64"),
    installPath,
    process.env.LD_LIBRARY_PATH || "",
  ]
    .filter(Boolean)
    .join(":");

  await new Promise<void>((resolve, reject) => {
    const proc = spawnProcess(steamcmdExe, ["+quit"], {
      cwd: installPath,
      env: { ...process.env, LD_LIBRARY_PATH: ldPaths },
    });
    proc.stdout.on("data", (d: any) =>
      emitRawSteamCmdLine(io, "steamcmd:log", "stdout", d.toString()),
    );
    proc.stderr.on("data", (d: any) =>
      emitRawSteamCmdLine(io, "steamcmd:log", "stderr", d.toString()),
    );
    proc.on("close", (code: any) => {
      if (code === 0 || code === 7) {
        resolve();
      } else {
        reject(new Error(`SteamCMD first-run setup exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });

  if (!fs.existsSync(steamcmdExe)) {
    throw new Error(
      `SteamCMD download completed but ${steamcmdExe} still missing`,
    );
  }

  emit("steamcmd:status", {
    status: "complete",
    message: "SteamCMD installed successfully!",
    path: installPath,
    progressCode: ProgressCode.STEAMCMD_INSTALL_COMPLETE,
  });
  log.info(`SteamCMD auto-installed to ${installPath}`);
  return steamcmdExe;
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

async function findSteamCmdPath() {
  const configuredPath = await getSetting("steamcmdPath");
  const candidates = [
    configuredPath,
    process.env.STEAMCMD_PATH,
    "/home/steam/steamcmd",
    "/home/steam/Steam/steamcmd",
    "/opt/steamcmd",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(getSteamCmdExe(candidate))) return candidate;
  }

  return null;
}

const activeSteamOperations = getActiveSteamOperations();

export function isFirstBootMissingAdminPassword(activeServer: AnyRecord | null) {
  if (
    !activeServer ||
    activeServer.isRemote ||
    !activeServer.serverName ||
    !activeServer.zomboidDataPath ||
    activeServer.adminPassword
  ) {
    return false;
  }
  const saveDir = path.join(
    activeServer.zomboidDataPath,
    "Saves",
    "Multiplayer",
    activeServer.serverName,
  );
  return !fs.existsSync(saveDir);
}

export function candidateIniPaths(
  serverConfigPath: string,
  zomboidDataPath: string | null,
  serverName: string,
) {
  const candidates = [];
  if (serverConfigPath) {
    candidates.push(path.join(serverConfigPath, `${serverName}.ini`));
  }
  if (zomboidDataPath) {
    candidates.push(path.join(zomboidDataPath, `${serverName}.ini`));
    candidates.push(path.join(zomboidDataPath, "servertest.ini"));
    candidates.push(path.join(zomboidDataPath, "serveroptions.ini"));
  }
  return candidates;
}

export async function ensureRconConfigured() {
  let serverConfigPathKind: "install" | "data" = "install";
  let serverConfigPath: string | null = null;
  try {
    const activeServer = await getActiveServer();
    if (!activeServer) {
      log.debug("ensureRconConfigured: No active server");
      return false;
    }

    serverConfigPathKind = activeServer.serverConfigPath ? "install" : "data";
    serverConfigPath =
      activeServer.serverConfigPath ||
      (activeServer.zomboidDataPath
        ? path.join(activeServer.zomboidDataPath, "Server")
        : null);
    const serverName = activeServer.serverName;
    const rconPassword = activeServer.rconPassword;
    const rconPort = activeServer.rconPort || 27015;

    if (!serverConfigPath || !serverName) {
      log.debug("ensureRconConfigured: Missing serverConfigPath or serverName");
      return false;
    }
    const configPath = serverConfigPath;

    if (!rconPassword) {
      log.debug("ensureRconConfigured: No RCON password configured");
      return false;
    }

    const iniPath =
      candidateIniPaths(
        serverConfigPath,
        activeServer.zomboidDataPath ?? null,
        serverName,
      ).find((candidate) => fs.existsSync(candidate)) ||
      path.join(serverConfigPath, `${serverName}.ini`);

    return await withFileLock(iniPath, async () => {
      if (!fs.existsSync(iniPath)) {
        log.info(
          `ensureRconConfigured: INI not found — pre-creating ${iniPath} with RCON settings`,
        );
        try {
          if (!fs.existsSync(configPath)) {
            fs.mkdirSync(configPath, { recursive: true });
            log.info(`Created server config directory: ${configPath}`);
          }
          const safePassword = sanitizeIniValue(rconPassword);
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${rconPort}\nRCONPassword=${safePassword}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings (port: ${rconPort})`);
          return true;
        } catch (createError: any) {
          if (createError.code === "EACCES") {
            const guidance = formatWritablePathError(
              serverConfigPathKind,
              configPath,
            );
            log.error(
              `Failed to pre-create INI file: ${createError.message} -- ${guidance.message}`,
            );
          } else {
            log.error(`Failed to pre-create INI file: ${createError.message}`);
          }
          return false;
        }
      }

      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");
      const hasCorrectPassword = hasIniKeyValue(content, "RCONPassword", rconPassword);
      const hasCorrectPort = hasIniKeyValue(content, "RCONPort", rconPort);

      if (hasCorrectPassword && hasCorrectPort) {
        log.debug("ensureRconConfigured: RCON already configured correctly");
        return true;
      }

      log.info(`Auto-configuring RCON in ${iniPath}`);

      const safePassword = sanitizeIniValue(rconPassword);
      content = setIniKeyLine(content, "RCONPassword", safePassword);
      content = setIniKeyLine(content, "RCONPort", rconPort);

      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
      log.info("RCON auto-configured successfully in server .ini file");
      return true;
    });
  } catch (error: any) {
    if (error.code === "EACCES" && serverConfigPath) {
      const guidance = formatWritablePathError(
        serverConfigPathKind,
        serverConfigPath,
      );
      log.error(
        `ensureRconConfigured error: ${error.message} -- ${guidance.message}`,
      );
    } else {
      log.error(`ensureRconConfigured error: ${error.message}`);
    }
    return false;
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

function sanitizeForBatch(str: any): string {
  if (!str) return "";
  return String(str)
    .replace(/[\x00-\x1F\x7F]/g, "")
    // a newline here closes out the current script line early and starts a
    // new one that the supervisor then executes as its own command)
    .replace(/[&|<>^%"`;$(){}[\]!]/g, "")
    .replace(/\.\./g, "")
    .trim();
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

function resolveZomboidPaths(installPath: string, zomboidDataPath: string | null) {
  const defaultZomboidDataPath =
    process.env.PZ_SAVE_PATH || `${installPath}_Data`;
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

const WRITABLE_PATH_LABELS = Object.freeze({
  install: "Installation path",
  data: "Zomboid data folder",
});

export function formatWritablePathError(
  kind: "install" | "data",
  directoryPath: string,
  platformIsWindows = isWindows,
) {
  const label = WRITABLE_PATH_LABELS[kind];
  const isContainer = !platformIsWindows && isContainerized();
  const baseMessage = `${label} is not writable: ${directoryPath}.`;

  if (isContainer) {
    return {
      message:
        `${baseMessage} Set PUID/PGID in your .env file to match the owner ` +
        `of this bind-mounted host folder (see docker-compose.yml's Quick ` +
        `Start), then recreate the container.`,
      code:
        kind === "install"
          ? ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER
          : ErrorCode.WRITABLE_PATH_DATA_CONTAINER,
      params: { path: directoryPath },
    };
  }

  return {
    message:
      `${baseMessage} The user running the panel does not own this folder ` +
      `or lacks write permission to it -- fix it with chown/chmod, or ` +
      `choose a folder the panel can already write to.`,
    code:
      kind === "install"
        ? ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL
        : ErrorCode.WRITABLE_PATH_DATA_BAREMETAL,
    params: { path: directoryPath },
  };
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

function buildClasspathEntries(installPath: string) {
  const entries = ["java/."];
  try {
    const javaDir = path.join(installPath, "java");
    if (fs.existsSync(javaDir)) {
      const jars = fs
        .readdirSync(javaDir)
        .filter((f) => f.toLowerCase().endsWith(".jar"))
        .sort();
      for (const jar of jars) {
        entries.push(`java/${jar}`);
      }
    }
  } catch (e: any) {
    log.warn(`Could not enumerate java/ jars for classpath: ${e.message}`);
  }
  if (entries.length === 1) {
    entries.push("java/projectzomboid.jar");
  }
  return entries;
}

export function generateStartupScripts(options: AnyRecord) {
  const {
    installPath,
    serverName,
    minMemory = 4,
    maxMemory = 8,
    zomboidDataPath,
    adminPassword,
    serverPort = 16261,
    useNoSteam = false,
    useDebug = false,
  } = options;

  const safeServerName = sanitizeForBatch(serverName);
  const safeAdminPassword = adminPassword
    ? sanitizeForBatch(adminPassword)
    : "";
  const safeZomboidDataPath = zomboidDataPath
    ? sanitizeForBatch(zomboidDataPath)
    : "";
  const normalizedMinMemory = normalizeMemoryGb(minMemory, 4);
  const normalizedMaxMemory = normalizeMemoryGb(maxMemory, 8);

  const softMaxMemory = Math.max(1, Math.round(normalizedMaxMemory * 0.6));

  const jvmArgs = [
    "-XX:+IgnoreUnrecognizedVMOptions",
    "-Djava.awt.headless=true",
    useNoSteam ? "-Dzomboid.steam=0" : "-Dzomboid.steam=1",
    "-Dzomboid.znetlog=1",
    "-XX:+UseZGC",
    `-XX:SoftMaxHeapSize=${softMaxMemory}g`,
    // Return freed heap to the OS in 2 minutes instead of the 5-minute default.
    "-XX:ZUncommitDelay=120",
    // JDK 25+: 8-byte object headers. PZ's heap is millions of small objects
    // (grid squares, tile properties, items), so this is a real footprint win.
    "-XX:+UseCompactObjectHeaders",
    // Scripts/tiles/item names load a lot of duplicate strings.
    "-XX:+UseStringDeduplication",
    "-XX:-CreateCoredumpOnCrash",
    "-XX:-OmitStackTraceInFastThrow",
    `-Xms${normalizedMinMemory}g`,
    `-Xmx${normalizedMaxMemory}g`,
  ];

  if (useDebug) {
    jvmArgs.push("-Ddebug");
  }

  const linuxJvmArgs = [
    ...jvmArgs,
    "-XX:+UseTransparentHugePages",
    "-Djava.security.egd=file:/dev/urandom",
  ];

  const gameArgs = [`-servername "${safeServerName}"`];

  if (safeZomboidDataPath) {
    gameArgs.push(`-cachedir="${safeZomboidDataPath}"`);
  }

  if (safeAdminPassword) {
    gameArgs.push(`-adminpassword "${safeAdminPassword}"`);
  }

  if (serverPort !== 16261) {
    gameArgs.push(`-port ${serverPort}`);
  }

  if (useNoSteam) {
    gameArgs.push("-nosteam");
  }

  const classpathEntries = buildClasspathEntries(installPath);

  const batchContent = `@echo off
@setlocal enableextensions
@cd /d "%~dp0"

REM =====================================================
REM Project Zomboid Server Startup Script
REM Generated by PZ Server Manager
REM Server Name: ${safeServerName}
REM Memory: ${normalizedMinMemory}GB - ${normalizedMaxMemory}GB
REM =====================================================

SET PZ_CLASSPATH=${classpathEntries.join(";")}

".\\jre64\\bin\\java.exe" ${jvmArgs.join(" ")} -Djava.library.path=natives/;natives/win64/;. -cp %PZ_CLASSPATH% zombie.network.GameServer ${gameArgs.join(" ")}

PAUSE
`;

  const shellContent = `#!/bin/bash
cd "\$(dirname "\$0")"

# =====================================================
# Project Zomboid Server Startup Script
# Generated by PZ Server Manager
# Server Name: ${safeServerName}
# Memory: ${normalizedMinMemory}GB - ${normalizedMaxMemory}GB
# =====================================================

PZ_CLASSPATH="${classpathEntries.join(":")}"

JAVA_CMD="./jre64/bin/java"
if [ ! -f "$JAVA_CMD" ]; then
  # Try common system Java locations (CentOS, Ubuntu, etc.)
  for JPATH in /usr/bin/java /usr/local/bin/java /usr/lib/jvm/jre/bin/java; do
    if [ -f "$JPATH" ]; then
      JAVA_CMD="$JPATH"
      break
    fi
  done
  if [ ! -f "$JAVA_CMD" ]; then
    JAVA_CMD="java"
  fi
fi

# Verify Java is actually available
if ! command -v "$JAVA_CMD" >/dev/null 2>&1; then
  echo "ERROR: Java not found. Install OpenJDK: sudo yum install java-17-openjdk (CentOS) or sudo apt install openjdk-17-jre (Ubuntu)"
  exit 1
fi

INSTDIR="$(dirname "$0")"
export LD_LIBRARY_PATH="\${INSTDIR}/natives/:\${INSTDIR}/natives/linux64/:\${INSTDIR}/linux64/:\${INSTDIR}:\${INSTDIR}/jre64/lib/amd64:\${INSTDIR}/jre64/lib/x86_64:/usr/lib64:\${LD_LIBRARY_PATH}"

"$JAVA_CMD" ${linuxJvmArgs.join(" ")} -Djava.library.path=natives/:natives/linux64/:linux64/:. -cp "$PZ_CLASSPATH" zombie.network.GameServer ${gameArgs.join(" ")}
`;

  return { bat: batchContent, sh: shellContent };
}

const SCRIPT_FINGERPRINT_FILE = ".pz-panel-scripts.json";

function hashScriptContent(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function regenerateStartupScriptsWithBackup(
  installPath: string,
  files: Array<{ path: string; content: string }>,
) {
  const fingerprintPath = path.join(installPath, SCRIPT_FINGERPRINT_FILE);
  let fingerprints: Record<string, string> = {};
  try {
    fingerprints = JSON.parse(fs.readFileSync(fingerprintPath, "utf8"));
  } catch {
    fingerprints = {};
  }

  const backupMessages: string[] = [];
  for (const { path: filePath, content } of files) {
    const fileName = path.basename(filePath);
    let existingContent = null;
    try {
      existingContent = fs.readFileSync(filePath, "utf8");
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      const knownHash = fingerprints[fileName];
      const currentHash = hashScriptContent(existingContent);
      if (!knownHash || knownHash !== currentHash) {
        let backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        if (fs.existsSync(backupPath)) {
          let suffix = 2;
          while (fs.existsSync(`${backupPath}-${suffix}`)) suffix++;
          backupPath = `${backupPath}-${suffix}`;
        }
        try {
          fs.copyFileSync(filePath, backupPath);
          backupMessages.push(
            `${fileName} had content the panel didn't last write (a hand-edit, or an install from before this backup existed) -- your version was saved to ${path.basename(backupPath)} before regenerating.`,
          );
        } catch (backupErr: any) {
          log.warn(
            `Could not back up ${filePath} before regenerating: ${backupErr.message}`,
          );
        }
      }
    }

    try {
      writeFileAtomic(
        filePath,
        content,
        filePath.endsWith(".sh") ? { encoding: "utf8", mode: 0o750 } : "utf8",
      );
      fingerprints[fileName] = hashScriptContent(content);
    } catch (writeErr: any) {
      log.warn(`Could not write ${filePath}: ${writeErr.message}`);
    }
  }

  try {
    writeFileAtomic(
      fingerprintPath,
      JSON.stringify(fingerprints, null, 2),
      "utf8",
    );
  } catch (fpErr: any) {
    log.warn(`Could not persist script fingerprint file: ${fpErr.message}`);
  }

  return backupMessages;
}


router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    log.debug("GET /status");

    const status = await serverManager.getServerStatus();
    const rconStatus = rconService.getConfig();

    res.json({
      ...status,
      rcon: rconStatus,
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

export async function refreshLaunchTargetBeforeStart(
  activeServer: AnyRecord | null,
  { managedHandled = false }: { managedHandled?: boolean } = {},
) {
  try {
    const rconReady = await ensureRconConfigured();
    if (rconReady) {
      log.info("RCON pre-configured in INI before server start");
    } else {
      log.warn(
        "Could not pre-configure RCON — will retry during startup polling",
      );
    }
  } catch (rconErr: any) {
    log.warn(`RCON pre-configuration failed: ${rconErr.message}`);
  }

  let scriptBackupWarnings: string[] = [];
  const launchMode = resolveLaunchMode(activeServer);
  if (
    !managedHandled &&
    activeServer &&
    !activeServer.startCommand &&
    activeServer.installPath &&
    launchMode.mode === "custom"
  ) {
    log.info(
      `Custom launcher mode active (${launchMode.launcherPath}) — not regenerating; the panel does not manage this script.`,
    );
  } else if (
    !managedHandled &&
    activeServer &&
    !activeServer.startCommand &&
    activeServer.installPath
  ) {
    try {
      const scripts = generateStartupScripts({
        installPath: activeServer.installPath,
        serverName: activeServer.serverName,
        minMemory: activeServer.minMemory || 4,
        maxMemory: activeServer.maxMemory || 8,
        zomboidDataPath: activeServer.zomboidDataPath || "",
        adminPassword: activeServer.adminPassword || "",
        serverPort: activeServer.serverPort || 16261,
        useNoSteam: activeServer.useNoSteam || false,
        useDebug: activeServer.useDebug || false,
      });
      const batPath = path.join(
        activeServer.installPath,
        `StartServer_${activeServer.serverName}.bat`,
      );
      const shPath = path.join(
        activeServer.installPath,
        `start-server_${activeServer.serverName}.sh`,
      );
      scriptBackupWarnings = regenerateStartupScriptsWithBackup(
        activeServer.installPath,
        [
          { path: batPath, content: scripts.bat },
          { path: shPath, content: scripts.sh.replace(/\r\n/g, "\n") },
        ],
      );
      if (scriptBackupWarnings.length > 0) {
        log.warn(
          `Startup script regeneration backed up existing content: ${scriptBackupWarnings.join(" ")}`,
        );
      }
      log.info("Regenerated startup scripts with current server config");
    } catch (scriptErr: any) {
      log.warn(`Could not regenerate startup scripts: ${scriptErr.message}`);
    }
  }
  return { scriptBackupWarnings };
}

async function waitForRconAfterStart({
  rconService,
  discordBot,
}: {
  rconService: any;
  discordBot: any;
}) {
  log.info("Waiting for RCON to be ready - starting port polling...");

  await rconService.loadConfig();
  const rconHost = rconService.config.host || "127.0.0.1";
  const rconPort = rconService.config.port || 27015;
  log.info(`Monitoring TCP port ${rconHost}:${rconPort} for activity...`);

  let rconConnected = false;
  let rconConfigured = false;
  let portOpen = false;

  const maxPollAttempts = 60;

  for (let i = 0; i < maxPollAttempts; i++) {
    if (!portOpen) {
      portOpen = await rconService.checkPortOpen(rconHost, rconPort);

      if (!portOpen) {
        log.debug(
          `RCON startup: Port ${rconHost}:${rconPort} not yet open (poll ${i + 1}/${maxPollAttempts})...`,
        );
        await new Promise((r) => setTimeout(r, 5000));

        if (!rconConfigured && i % 3 === 0) {
          rconConfigured = await ensureRconConfigured();
          if (rconConfigured) {
            log.info(
              "RCON settings auto-configured in server .ini file during startup wait",
            );
          }
        }
        continue;
      }
      log.info(
        `RCON port ${rconHost}:${rconPort} is now open! Initiating connection...`,
      );
    }

    if (rconService.forceResetConnectionState) {
      rconService.forceResetConnectionState();
    }

    try {
      const connectPromise = rconService.connect();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Connection attempt timed out after 15s")),
          15000,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      if (rconService.connected) {
        log.info("RCON connected successfully after server startup");
        rconConnected = true;
        break;
      } else {
        log.warn(
          `RCON connected to port but authentication/handshake failed. Retrying...`,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e: any) {
      log.warn(`RCON connection attempt failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (rconConnected) {
    log.info("RCON startup sequence completed - connected");
    discordBot
      ?.sendEventNotification("serverStart", {})
      .catch((err: any) =>
        log.debug(`Discord serverStart notification failed: ${err.message}`),
      );
  } else {
    log.warn(
      "RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)",
    );
  }

  if (rconService.setServerStarting) {
    rconService.setServerStarting(false);
  } else {
    rconService.serverStarting = false;
  }
}

router.post("/start", requirePermission("server.control"), async (req, res) => {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "start",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
  };
  try {
    const activeServer = activeServerForLock;
    log.info(
      `POST /start (server=${activeServer?.name || "unknown"}, remote=${activeServer?.isRemote || false})`,
    );
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot start a remote server. Remote servers are managed externally — use RCON to interact.",
        code: ErrorCode.SERVER_START_REMOTE_REFUSED,
      });
    }
    if (!activeServer) {
      return res.status(404).json({ error: "No active server configured" });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");

    autoInstallBridgeIfNeeded(activeServer);

    const managed = await runManagedLifecycle("start", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res.status(502).json({ error: sanitizeError(managed.error) });
    }
    if (managed.alreadyRunning) {
      return res.json(managed);
    }

    if (!managed.handled && isFirstBootMissingAdminPassword(activeServer)) {
      return res.status(400).json({
        error:
          `${activeServer.name || activeServer.serverName} has never started before and has no admin password set. ` +
          `Project Zomboid needs one to create the admin account on first boot, or the server process hangs waiting ` +
          `for console input that will never come and crashes. Set an admin password for this server (My Servers → ` +
          `${activeServer.name || activeServer.serverName} → Admin Password), then try starting again.`,
      });
    }

    const { scriptBackupWarnings } = await refreshLaunchTargetBeforeStart(
      activeServer,
      { managedHandled: Boolean(managed.handled) },
    );

    const result = managed.handled
      ? { success: true, message: managed.message || "Container starting" }
      : await serverManager.startServer({
          serverId: activeServer?.id ?? null,
        });
    if (scriptBackupWarnings.length > 0) {
      result.scriptWarnings = scriptBackupWarnings;
    }

    const io = req.app.get("io");

    if (rconService.setServerStarting) {
      rconService.setServerStarting(true);
    } else {
      rconService.serverStarting = true;
    }

    if (managed.handled) {
      if (io) io.emit("server:status", { running: true });
      log.info("Container start confirmed by Docker; skipping local process poll");
      lifecycleLockTransferred = true;
      void waitForRconAfterStart({
        rconService,
        discordBot: req.app.get("discordBot"),
      })
        .catch((err: any) =>
          log.error(`Post-start RCON wait failed: ${err.message}`),
        )
        .finally(() => releaseLifecycleLock());
      res.json(result);
      return;
    }

    let attempts = 0;
    const maxAttempts = 30;
    let pollCleared = false;

    const pollInterval = setInterval(async () => {
      if (pollCleared) return;
      try {
        attempts++;
        const processDetails =
          typeof serverManager.getServerProcessDetails === "function"
            ? await serverManager.getServerProcessDetails()
            : { running: false, scanFailed: true };

        if (!processDetails || processDetails.scanFailed) {
          if (attempts >= maxAttempts) {
            pollCleared = true;
            clearInterval(pollInterval);
            releaseLifecycleLock();
            if (rconService.setServerStarting) {
              rconService.setServerStarting(false);
            } else {
              rconService.serverStarting = false;
            }
            log.warn(
              "Server start polling timed out without confirming process state",
            );
          }
          return;
        }

        const isRunning = Boolean(processDetails.running);

        if (isRunning) {
          pollCleared = true;
          clearInterval(pollInterval);
          if (io) io.emit("server:status", { running: true });
          log.info("Server detected as running");
          await waitForRconAfterStart({ rconService, discordBot: req.app.get("discordBot") });
          releaseLifecycleLock();
        } else if (attempts >= maxAttempts) {
          pollCleared = true;
          clearInterval(pollInterval);
          releaseLifecycleLock();
          if (rconService.setServerStarting) {
            rconService.setServerStarting(false);
          } else {
            rconService.serverStarting = false;
          }
          log.warn("Server start polling timed out");
        }
      } catch (err: any) {
        pollCleared = true;
        clearInterval(pollInterval);
        releaseLifecycleLock();
        if (rconService.setServerStarting) {
          rconService.setServerStarting(false);
        } else {
          rconService.serverStarting = false;
        }
        log.error(`Server status poll failed: ${err.message}`);
      }
    }, 1000);
    lifecycleLockTransferred = true;

    res.json(result);
  } catch (error: any) {
    log.error(`Failed to start server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
});

router.post("/stop", requirePermission("server.control"), async (req, res) => {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "stop",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
  };
  try {
    const activeServer = activeServerForLock;
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    log.info("POST /stop — graceful shutdown requested");

    if (!rconService.connected) {
      return res
        .status(400)
        .json({
          error: "RCON not connected. Cannot gracefully stop server.",
          code: ErrorCode.SERVER_STOP_RCON_NOT_CONNECTED,
        });
    }

    const saved = await rconService.save({ retryOnConnectionError: false });
    if (!saved?.success) {
      return res.status(502).json({
        error: `Save failed, so the server was left running: ${sanitizeError(saved?.error)}`,
        code: ErrorCode.SERVER_STOP_SAVE_FAILED,
      });
    }

    const managed = await runManagedLifecycle("stop", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res.status(502).json({
        error: `The world was saved, but the container could not be stopped: ${sanitizeError(managed.error)}`,
        code: ErrorCode.SERVER_STOP_CONTAINER_STOP_FAILED,
      });
    }

    if (!managed.handled && serverManager.loadConfig) {
      await serverManager.loadConfig(activeServer?.id ?? null);
    }
    const serviceManaged = Boolean(
      !managed.handled && serverManager.usesManagedServiceLifecycle?.(),
    );
    const result = managed.handled
      ? { success: true, message: managed.message || "Container stopping" }
      : serviceManaged
        ? await serverManager.stopServer(false, {
            serverId: activeServer?.id ?? null,
          })
        : await rconService.quit({ retryOnConnectionError: false });

    if (!result?.success || result.confirmed === false) {
      return res.status(502).json({
        ...result,
        success: false,
        error: result?.error || result?.message || "Server stop failed",
      });
    }

    if (managed.handled || serviceManaged) {
      serverManager?.markServerStopped?.();
      const io = req.app.get("io");
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("managed-stop")).catch((err: any) =>
          log.debug(`Post-stop status re-check failed: ${err.message}`),
        );
      } else if (io) {
        io.emit("server:status", { running: false });
      }
      await logServerEventBestEffort(
        "server_stop",
        serviceManaged
          ? `Server stopped through ${serverManager.lifecycleProvider}`
          : "Server stopped via web UI",
      );
      req.app
        .get("discordBot")
        ?.sendEventNotification("serverStop", {})
        .catch((err: any) =>
          log.debug(`Discord serverStop notification failed: ${err.message}`),
        );
    } else {
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("graceful-stop")).catch((err) =>
          log.debug(`Post-stop status re-check failed: ${err.message}`),
        );
      }
      await logServerEventBestEffort(
        "server_stop",
        "Graceful shutdown requested via web UI",
      );
      result.message =
        result.message || result.response || "Shutdown requested";
      result.confirmed = false;
      monitorGracefulStop(serverManager, releaseLifecycleLock);
      lifecycleLockTransferred = true;
    }

    res.json(result);
  } catch (error: any) {
    log.error(`Failed to stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
});

const FORCE_STOP_SAVE_TIMEOUT_MS = 3000;
const GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

function monitorGracefulStop(serverManager: any, releaseLifecycleLock: any) {
  if (typeof serverManager?.getServerProcessDetails !== "function") {
    releaseLifecycleLock();
    return;
  }

  const deadline = Date.now() + GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS;
  const poll = async () => {
    try {
      const details = await serverManager.getServerProcessDetails();
      if (details && !details.scanFailed && details.running === false) {
        releaseLifecycleLock();
        return;
      }
    } catch (error: any) {
      log.debug(`Graceful stop confirmation failed: ${error.message}`);
    }

    if (Date.now() >= deadline) {
      log.warn("Graceful stop confirmation timed out; releasing lifecycle lock");
      releaseLifecycleLock();
      return;
    }

    const timer = setTimeout(() => {
      void poll();
    }, 1000);
    timer.unref?.();
  };

  void poll();
}

async function attemptBoundedSaveBeforeForceStop(rconService: any) {
  if (!rconService?.connected) return "skipped";
  try {
    const saveResult = await Promise.race([
      rconService.save({ retryOnConnectionError: false }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Force-stop save timed out")),
          FORCE_STOP_SAVE_TIMEOUT_MS,
        ),
      ),
    ]);
    return saveResult?.success ? "saved" : "failed";
  } catch {
    return "timedOut";
  }
}

router.post("/force-stop", requirePermission("server.control"), async (req, res) => {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "force-stop",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    log.info("POST /force-stop — force kill requested");
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot force-stop a remote server. The process is not managed by this panel.",
        code: ErrorCode.SERVER_FORCE_STOP_REMOTE_REFUSED,
      });
    }

    const rconService = req.app.get("rconService");
    const saveOutcome = await attemptBoundedSaveBeforeForceStop(rconService);
    log.info(`POST /force-stop — pre-stop save attempt: ${saveOutcome}`);

    const managed = await runManagedLifecycle("stop", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res
        .status(502)
        .json({ error: sanitizeError(managed.error), saveOutcome });
    }

    const serverManager = req.app.get("serverManager");
    const result = managed.handled
      ? {
          success: true,
          message: managed.message || "Container stopped.",
        }
      : await serverManager.stopServer(false, {
          serverId: activeServer?.id ?? null,
        });

    if (!result?.success || result.confirmed === false) {
      return res.status(502).json({
        ...result,
        success: false,
        error: result?.error || result?.message || "Force stop failed",
        saveOutcome,
      });
    }

    serverManager?.markServerStopped?.();

    const io = req.app.get("io");
    const checkServerStatusNow = req.app.get("checkServerStatusNow");
    if (typeof checkServerStatusNow === "function") {
      Promise.resolve(checkServerStatusNow("force-stop")).catch((err) =>
        log.debug(`Post-stop status re-check failed: ${err.message}`),
      );
    } else if (io) {
      io.emit("server:status", { running: false });
    }

    res.json({ ...result, saveOutcome });
  } catch (error: any) {
    log.error(`Failed to force stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

router.post("/restart", requirePermission("server.control"), async (req, res) => {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "restart",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  try {
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot restart a remote server. The process is not managed by this panel.",
        code: ErrorCode.SERVER_RESTART_REMOTE_REFUSED,
      });
    }

    const scheduler = req.app.get("scheduler");
    if (scheduler.restartInProgress) {
      lifecycleLock.release();
      return res.status(409).json(lifecycleInProgressResponse());
    }
    let warningMinutes = parseBoundedInteger(
      req.body?.warningMinutes,
      5,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (warningMinutes > 60) {
      warningMinutes = 60;
    }

    const io = req.app.get("io");

    autoInstallBridgeIfNeeded(activeServer);

    const restartPromise = Promise.resolve(
      scheduler.performRestart(warningMinutes, {
        label: "Manual restart",
        lifecycleLock,
      }),
    );
    lifecycleLockTransferred = true;
    void restartPromise
      .then((result) => {
        emitActionResult(io, {
          kind: "restart",
          success: !!result?.success,
          message: result?.message || (result?.success ? "Restart completed" : "Restart failed"),
        });
      })
      .catch((err) => {
        log.error(`Restart failed: ${err.message}`);
        emitActionResult(io, {
          kind: "restart",
          success: false,
          message: err.message,
        });
      })
      .finally(() => lifecycleLock.release());

    res.json({
      success: true,
      message:
        warningMinutes > 0
          ? `Restart initiated with ${warningMinutes} minute warning`
          : "Immediate restart initiated",
    });
  } catch (error: any) {
    log.error(`Failed to restart server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) lifecycleLock.release();
  }
});

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
        branchSpawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
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
      steamcmdPath,
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

    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");
    log.info(
      `POST /install (steamcmd=${steamcmdPath}, install=${installPath}, server=${serverName}, branch=${selectedBranch}, noSteam=${useNoSteam}, debug=${useDebug})`,
    );

    if (!steamcmdPath || !installPath || !serverName) {
      return res.status(400).json({
        error: "Missing required fields: steamcmdPath, installPath, serverName",
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

    const safeAdminPassword = sanitizeForBatch(adminPassword);

    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      if (isWindows) {
        return res
          .status(400)
          .json({ error: `SteamCMD not found at: ${steamcmdExe}`, code: ErrorCode.STEAMCMD_NOT_FOUND_AT_PATH });
      }
      try {
        steamcmdExe = await ensureSteamCmdLinux(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr: any) {
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
      spawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
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
            await setSetting("rconHost", "127.0.0.1");
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
      await setSetting("rconHost", "127.0.0.1");

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
    await setSetting("rconHost", "127.0.0.1");

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

export async function applyUpnpToIni(
  serverConfigPath: string,
  serverName: string,
  useUpnp: boolean,
) {
  const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
  if (!fs.existsSync(iniPath)) {
    return { applied: false, reason: `Server config not found at ${iniPath}` };
  }
  try {
    await withFileLock(iniPath, async () => {
      let content = fs.readFileSync(iniPath, "utf-8").replace(/\r\n/g, "\n");
      const upnpValue = useUpnp ? "true" : "false";
      content = setIniKeyLine(content, "UPnP", upnpValue);
      writeFileAtomic(iniPath, content, { encoding: "utf-8", mode: 0o600 });
    });
    return { applied: true };
  } catch (error: any) {
    return { applied: false, reason: sanitizeError(error.message) };
  }
}

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

    const serverManager = req.app.get("serverManager");
    try {
      const processDetails = await serverManager.getServerProcessDetails();
      if (processDetails.scanFailed) {
        return res.status(503).json({
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      if (processDetails.running) {
        return res.status(400).json({
          error:
            "Server is currently running. Please stop the server before updating.",
          code: ErrorCode.STEAM_UPDATE_SERVER_RUNNING,
        });
      }
    } catch (e: any) {
      log.warn(`Could not verify server status before update: ${e.message}`);
      return res.status(503).json({
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }

    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      if (isWindows) {
        return res
          .status(400)
          .json({ error: `SteamCMD not found at: ${steamcmdExe}`, code: ErrorCode.STEAMCMD_NOT_FOUND_AT_PATH });
      }
      try {
        steamcmdExe = await ensureSteamCmdLinux(
          steamcmdPath,
          req.app.get("io"),
        );
      } catch (dlErr: any) {
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
      updateSpawnOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
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
        fs.unlink(zipPath, () => {});
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
      io.emit("steamcmd:status", {
        status: "initializing",
        message: "Initializing SteamCMD (first run)...",
        progressCode: ProgressCode.STEAMCMD_INITIALIZING,
      });
      log.info("Running SteamCMD first-time setup...");

      const steamcmdExe = getSteamCmdExe(installPath);
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
        firstRunOpts.env = { ...process.env, LD_LIBRARY_PATH: ldPaths };
      }
      const steamcmd = spawnProcess(steamcmdExe, ["+quit"], firstRunOpts);

      steamcmd.stdout.on("data", (data: any) => {
        emitRawSteamCmdLine(io, "steamcmd:log", "stdout", data.toString());
      });

      steamcmd.stderr.on("data", (data: any) => {
        emitRawSteamCmdLine(io, "steamcmd:log", "stderr", data.toString());
      });

      steamcmd.on("close", (code: any) => {
        if (code === 0 || code === 7) {
          io.emit("steamcmd:status", {
            status: "complete",
            message: "SteamCMD installed successfully!",
            path: installPath,
            progressCode: ProgressCode.STEAMCMD_INSTALL_COMPLETE,
          });
          log.info(`SteamCMD installed successfully to ${installPath}`);
        } else {
          io.emit("steamcmd:status", {
            status: "error",
            message: `SteamCMD setup failed with code ${code}`,
            progressCode: ProgressCode.STEAMCMD_SETUP_FAILED,
            params: { code },
          });
          log.error(`SteamCMD first-run failed with code ${code}`);
        }
      });

      steamcmd.on("error", (error: any) => {
        io.emit("steamcmd:status", {
          status: "error",
          message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
          progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
          params: { reason: sanitizeError(error.message) },
        });
        log.error(`SteamCMD run error: ${error.message}`);
      });
    }

    res.json({ success: true, message: "SteamCMD download started" });
  } catch (error: any) {
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

async function checkServerConfirmedStopped(serverManager: any, actionLabel: string) {
  const processDetails = await serverManager.getServerProcessDetails();
  if (processDetails.scanFailed) {
    return {
      status: 503,
      body: {
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  if (processDetails.running) {
    return {
      status: 400,
      body: {
        error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
        code: ErrorCode.WIPE_SERVER_RUNNING,
      },
    };
  }
  return null;
}

router.post("/delete-files", requirePermission("server.wipe"), async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

    const notStoppedError = await checkServerConfirmedStopped(serverManager, "deleting its files");
    if (notStoppedError) {
      return res.status(notStoppedError.status).json(notStoppedError.body);
    }

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
    const configuredServers = await getServers();
    const matchesConfiguredServer = configuredServers.some(
      (s) => s.installPath && path.resolve(s.installPath) === resolvedDeletePath,
    );
    if (!matchesConfiguredServer) {
      return res.status(400).json({
        error:
          "This path doesn't match a server the panel has on record. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_CONFIGURED_SERVER,
      });
    }

    const zomboidDataPath = serverManager.savePath;
    if (zomboidDataPath) {
      const resolvedDeletePath = path.resolve(deletePath);
      if (confineToRoots(zomboidDataPath, [resolvedDeletePath])) {
        return res.status(400).json({
          error: `Refusing to delete: this server's Zomboid data folder (${zomboidDataPath}) is inside the folder you're about to delete, so this would also permanently destroy the world save. Move the data path outside the install folder in Settings, or back it up yourself first, before deleting.`,
          code: ErrorCode.DELETE_FILES_DATA_PATH_NESTED,
        });
      }
    }

    const stillNotStoppedError = await checkServerConfirmedStopped(serverManager, "deleting its files");
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
    await serverManager.loadConfig();

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
    const savePath = serverManager.savePath;
    const serverName = serverManager.serverName || "servertest";
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

  let serverName = null;
  let backupResult = null;
  let results: AnyRecord = {};
  let targets: string[] | null = null;

  try {
    const serverManager = req.app.get("serverManager");
    await serverManager.loadConfig();

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

    const savePath = serverManager.savePath;
    serverName = serverManager.serverName || "servertest";
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
      backupResult = await backupService.createBackup({ isPreWipe: true, io });
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
            await backupService.getBackupsPath(),
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
  }
});

export default router;

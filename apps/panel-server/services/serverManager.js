import { spawn, exec, execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";
import { createLogger } from "../utils/logger.js";
const log = createLogger("Server");
import {
  logServerEvent,
  getSetting,
  setSetting,
  getActiveServer,
  getServer,
  getServers,
} from "../database/init.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { escapeRegExp } from "../utils/regex.js";
import { getDataPaths } from "../utils/paths.js";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import {
  createLinuxServiceLifecycle,
  isManagedLifecycleProvider,
} from "./linuxServiceLifecycle.js";
import { hasActiveSteamOperation } from "./activeSteamOperations.js";

const isWindows = process.platform === "win32";
const PUBLIC_IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const KILL_EXEC_TIMEOUT_MS = 8000;

export function resolveConfiguredRconPort(value, fallback = 27015) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return fallback;
  }
  return parseBoundedInteger(value, null, 1, 65535);
}

function getConfiguredIpv4Address(variableName) {
  const address = process.env[variableName]?.trim();
  return address && net.isIP(address) === 4 ? address : null;
}

export function classifyProcessKillError(error) {
  if (!error) return "success";
  if (error?.killed) return "timedOut";

  const message = `${error?.message || ""} ${error?.stderr || ""}`.toLowerCase();
  if (
    error?.code === "ESRCH" ||
    /no such process|not found|no matching process|no instances|not running/.test(
      message,
    ) ||
    (error?.code === 1 && !String(error?.stderr || "").trim())
  ) {
    return "alreadyGone";
  }

  return "failed";
}

function buildLdLibraryPath(serverDir) {
  log.debug(
    `buildLdLibraryPath: scanning candidates for serverDir=${serverDir}`,
  );
  const candidates = [
    path.join(serverDir, "linux64"),
    path.join(serverDir, "natives", "linux64"),
    path.join(serverDir, "natives"),
    serverDir,
    path.join(serverDir, "jre64", "lib", "amd64"),
    path.join(serverDir, "jre64", "lib", "x86_64"), // CentOS uses x86_64 instead of amd64
    "/usr/lib64", // CentOS system 64-bit libs
  ];
  const existing = candidates.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const extra = process.env.LD_LIBRARY_PATH || "";
  const result = [...existing, extra].filter(Boolean).join(":");
  log.debug(
    `buildLdLibraryPath: ${existing.length}/${candidates.length} dirs exist → LD_LIBRARY_PATH=${result}`,
  );
  return result;
}

export function windowsQuoteArgIfNeeded(value) {
  return /[\s"&<>()^|,;=]/.test(value) ? `"${value}"` : value;
}

export function buildWindowsCmdLine(exePath, args, launchLogPath) {
  const parts = [
    windowsQuoteArgIfNeeded(exePath),
    ...args.map(windowsQuoteArgIfNeeded),
  ];
  if (launchLogPath) {
    parts.push(">", windowsQuoteArgIfNeeded(launchLogPath), "2>&1");
  }
  return `"${parts.join(" ")}"`;
}

export function parseCustomStartCommand(startCommand) {
  const parts = startCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [
    startCommand,
  ];
  const cmd = parts[0].replace(/"/g, "");
  const args = parts.slice(1).map((a) => a.replace(/"/g, ""));
  return { cmd, args };
}

function findJvmExecutable(serverDir) {
  const candidates = [
    path.join(serverDir, "jre64", "bin", "java"),
    path.join(serverDir, "jre", "bin", "java"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

const ALLOWED_CMD_EXTENSIONS = isWindows
  ? [".bat", ".cmd", ".exe"]
  : [".sh", ""];

function validateStartCommand(cmd) {
  if (!cmd || typeof cmd !== "string")
    return { valid: false, reason: "Command is empty" };
  if (cmd.length > 1024)
    return { valid: false, reason: "Command exceeds 1024 characters" };
  if (/[&|;<>`${}()!%\[\]\n\r]/.test(cmd)) {
    return {
      valid: false,
      reason:
        "Command contains disallowed shell characters: & | ; < > ` $ { } ( ) ! % [ ]",
    };
  }
  return { valid: true };
}

function getDefaultStartupScript() {
  return isWindows ? "StartServer64.bat" : "start-server.sh";
}

export function isWindowsDedicatedServerCommandLine(commandLine) {
  const normalized =
    typeof commandLine === "string" ? commandLine.toLowerCase() : "";
  if (!normalized) return false;

  if (normalized.includes("zombie.network.gameserver")) {
    return true;
  }

  if (
    normalized.includes("projectzomboid64.exe") ||
    normalized.includes("projectzomboid32.exe")
  ) {
    if (
      normalized.includes("-server") ||
      normalized.includes("startserver") ||
      normalized.includes("-servername")
    ) {
      return true;
    }
  }

  if (
    normalized.includes("zomboid") &&
    (normalized.includes("-server") || normalized.includes("startserver"))
  ) {
    return true;
  }

  return false;
}

function isLinuxDedicatedServerCommandLine(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  if (!lower) return false;
  if (lower.includes("zombie.network.gameserver")) return true;
  if (
    lower.includes("projectzomboid64") ||
    lower.includes("projectzomboid32")
  ) {
    if (
      lower.includes("-server") ||
      lower.includes("startserver") ||
      lower.includes("-servername")
    ) {
      return true;
    }
    return false;
  }
  if (
    lower.includes("zomboid") &&
    (lower.includes("-server") || lower.includes("startserver"))
  ) {
    return true;
  }
  return false;
}

function looksZomboidAdjacent(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  return lower.includes("zomboid") || lower.includes("zombie.network");
}

function looksLikeUndeterminedJvmCandidate(commandLine) {
  const lower = String(commandLine || "").toLowerCase();
  if (!looksZomboidAdjacent(lower)) return false;
  return /\bjava\b|\bjavaw\b|\/java$/.test(lower);
}

function extractLaunchArgValue(commandLine, flag) {
  const pattern = new RegExp(
    `(?:^|\\s)-${flag}(?:\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|\\S+)`,
    "i",
  );
  const match = String(commandLine || "").match(pattern);
  if (!match) return null;
  const value = match[1].replace(/^["']|["']$/g, "").trim();
  return value || null;
}

function normalizePathForCompare(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return isWindows ? normalized.toLowerCase() : normalized;
}

export function resolveLaunchMode(server) {
  const raw = server?.serverPath || server?.installPath;
  if (!raw || typeof raw !== "string") {
    return { mode: "managed", launcherPath: null };
  }
  const lower = raw.toLowerCase();
  if (lower.endsWith(".bat") || lower.endsWith(".sh") || lower.endsWith(".exe")) {
    return { mode: "custom", launcherPath: raw };
  }
  return { mode: "managed", launcherPath: null };
}

export function scoreServerProcessOwnership(commandLine, descriptor = {}) {
  const cmd = String(commandLine || "");
  if (!cmd) return 0;

  let score = 0;

  const nameArg = extractLaunchArgValue(cmd, "servername");
  if (nameArg && descriptor.serverName) {
    if (nameArg.toLowerCase() !== String(descriptor.serverName).toLowerCase()) {
      return -1;
    }
    score += 3;
  }

  const cacheArg = extractLaunchArgValue(cmd, "cachedir");
  if (cacheArg && descriptor.savePath) {
    if (
      normalizePathForCompare(cacheArg) !==
      normalizePathForCompare(descriptor.savePath)
    ) {
      return -1;
    }
    score += 2;
  }

  const installPath = normalizePathForCompare(descriptor.serverPath);
  if (installPath && normalizePathForCompare(cmd).includes(installPath)) {
    score += 1;
  }

  return score;
}

export class ServerManager {
  constructor({ lifecycleFactory = createLinuxServiceLifecycle } = {}) {
    this.serverProcess = null;
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = null;
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.isRunning = false;
    this.startTime = null;
    this.configLoaded = false;
    this.launchMode = "managed";
    this.lifecycleProvider = "direct";
    this._serverRecord = null;
    this._lifecycleFactory = lifecycleFactory;
    this._serverId = null;
    this.publicIp = null;
    this.gamePort = null;
    this.fetchingIp = false;
    this._killTimeoutMs = KILL_EXEC_TIMEOUT_MS;
  }

  async reloadConfig(serverId = null) {
    this.serverPath = process.env.PZ_SERVER_PATH || "";
    this.serverBat = process.env.PZ_SERVER_BAT || getDefaultStartupScript();
    this.savePath = process.env.PZ_SAVE_PATH || "";
    this.serverName = null;
    this.startCommand = "";
    this.rconHost = null;
    this.rconPort = null;
    this.launchMode = "managed";
    this.lifecycleProvider = "direct";
    this._serverRecord = null;
    this.configLoaded = false;
    await this.loadConfig(serverId);
  }

  async loadConfig(serverId = null) {
    if (this.configLoaded) return;
    this._serverId = serverId;
    try {
      const activeServer = serverId
        ? await getServer(serverId)
        : await getActiveServer();
      if (activeServer) {
        this._serverRecord = activeServer;
        this.lifecycleProvider = activeServer.lifecycleProvider || "direct";
        let serverDir = activeServer.serverPath || activeServer.installPath;

        const launchMode = resolveLaunchMode(activeServer);
        this.launchMode = launchMode.mode;
        if (launchMode.mode === "custom") {
          const batchFileName = path.basename(launchMode.launcherPath);
          serverDir = path.dirname(launchMode.launcherPath);
          this.serverBat = batchFileName;
          log.debug(`Using custom launcher: ${batchFileName}`);
        }

        if (serverDir) {
          this.serverPath = serverDir;
          log.debug(`Loaded serverPath: ${serverDir}`);
        }

        if (activeServer.serverName) {
          this.serverName = activeServer.serverName;
          if (!this.serverBat || this.serverBat === getDefaultStartupScript()) {
            if (isWindows) {
              const customBat = `StartServer_${activeServer.serverName}.bat`;
              const customBatPath = path.join(this.serverPath, customBat);
              if (fs.existsSync(customBatPath)) {
                this.serverBat = customBat;
              } else if (activeServer.useNoSteam) {
                this.serverBat = "StartServer64_nosteam.bat";
              } else {
                this.serverBat = "StartServer64.bat";
              }
            } else {
              const customSh = `start-server_${activeServer.serverName}.sh`;
              const customShPath = path.join(this.serverPath, customSh);
              if (fs.existsSync(customShPath)) {
                this.serverBat = customSh;
              } else if (activeServer.useNoSteam) {
                this.serverBat = "start-server.sh";
              } else {
                this.serverBat = "start-server.sh";
              }
            }
          }
        }
        if (activeServer.zomboidDataPath) {
          this.savePath = activeServer.zomboidDataPath;
        }
        if (activeServer.startCommand) {
          this.startCommand = activeServer.startCommand;
          log.debug(`Using custom start command: ${this.startCommand}`);
        }
        this.rconHost = activeServer.rconHost || this.rconHost;
        this.rconPort = activeServer.rconPort || this.rconPort;
        this.configLoaded = true;
        log.debug(`Loaded config from active server: ${activeServer.name}`);
        return;
      }

      if (!serverId) {
        const dbServerPath = await getSetting("serverPath");
        const dbServerName = await getSetting("serverName");
        const dbZomboidPath = await getSetting("zomboidDataPath");

        if (dbServerPath) {
          this.serverPath = dbServerPath;
          log.debug(`Loaded serverPath from database: ${dbServerPath}`);
        }
        if (dbServerName) {
          const safeServerName = path.basename(dbServerName);
          if (safeServerName === dbServerName && safeServerName) {
            this.serverName = dbServerName;
            if (isWindows) {
              this.serverBat = `StartServer_${dbServerName}.bat`;
            } else {
              this.serverBat = `start-server_${dbServerName}.sh`;
            }
          } else {
            log.warn(
              `Ignoring legacy settings.serverName "${dbServerName}" -- contains path-unsafe characters. Re-save the server name in Settings to clear this.`,
            );
          }
        }
        if (dbZomboidPath) {
          this.savePath = dbZomboidPath;
        }
        this.rconHost = (await getSetting("rconHost")) || this.rconHost;
        this.rconPort = (await getSetting("rconPort")) || this.rconPort;
      } else {
        log.warn(`No server config found for server ${serverId}`);
      }
      this.configLoaded = true;
    } catch (error) {
      log.debug(`Could not load server config from database: ${error.message}`);
    }
  }

  async checkServerRunning() {
    const details = await this.getServerProcessDetails();
    return details.running;
  }

  isJvmExecutableBusy() {
    if (isWindows) return false;

    const javaPath = findJvmExecutable(path.resolve(this.serverPath || ""));
    if (!javaPath) return false;

    try {
      const fd = fs.openSync(javaPath, "r+");
      fs.closeSync(fd);
      return false;
    } catch (error) {
      if (error?.code === "ETXTBSY") return true;
      log.debug(
        `isJvmExecutableBusy: could not probe ${javaPath} (${error?.code || error?.message}), not treating as busy`,
      );
      return false;
    }
  }

  _getOwnershipDescriptor() {
    return {
      serverName: this.serverName,
      savePath: this.savePath,
      serverPath: this.serverPath,
    };
  }

  async getServerProcessDetails() {
    await this.loadConfig(this._serverId);

    if (this.usesManagedServiceLifecycle()) {
      try {
        const lifecycle = this._getManagedLifecycle();
        const status = await lifecycle.status();
        if (!status.scanFailed) this.isRunning = status.running;
        return {
          running: status.running,
          matched: [],
          owned: [],
          scanFailed: Boolean(status.scanFailed),
          provider: this.lifecycleProvider,
          serviceName: lifecycle.serviceName,
          ...(status.error ? { error: status.error } : {}),
        };
      } catch (error) {
        log.warn(
          `Managed lifecycle status failed for "${this.serverName}": ${error.message}`,
        );
        return {
          running: false,
          matched: [],
          owned: [],
          scanFailed: true,
          provider: this.lifecycleProvider,
          error: error.message,
        };
      }
    }

    const fastPath = await this._tryPidFileFastPath();
    if (fastPath) return fastPath;

    const scan = await this._scanDedicatedServerProcesses();
    const descriptor = this._getOwnershipDescriptor();

    const owned = [];
    const unattributable = [];
    for (const candidate of scan.matched) {
      const score = scoreServerProcessOwnership(candidate.cmd, descriptor);
      if (score > 0) owned.push(candidate);
      else if (score === 0) unattributable.push(candidate);
    }

    const resolved = owned.length > 0 ? owned : unattributable;
    if (scan.matched.length !== resolved.length) {
      log.debug(
        `getServerProcessDetails: ${scan.matched.length} PZ server process(es) on this host, ${resolved.length} belong to "${this.serverName}"`,
      );
    }

    if (!scan.scanFailed && owned.length === 0 && scan.ambiguous?.length > 0) {
      log.warn(
        `getServerProcessDetails: found ${scan.ambiguous.length} ambiguous JVM-shaped process(es) while no process could be attributed to "${this.serverName}" -- cannot confirm the server is stopped`,
      );
      return {
        running: false,
        matched: [],
        owned: [],
        scanFailed: true,
      };
    }

    if (!scan.scanFailed) {
      this.isRunning = resolved.length > 0;
    }
    return {
      running: resolved.length > 0,
      matched: resolved.slice(0, 3).map((entry) => ({
        ...(entry.pid ? { pid: String(entry.pid) } : {}),
        cmd: String(entry.cmd || "").slice(0, 240),
      })),
      owned: resolved,
      scanFailed: Boolean(scan.scanFailed),
    };
  }

  async _scanDedicatedServerProcesses() {
    return new Promise((resolve) => {
      log.debug(
        `getServerProcessDetails: starting detection (platform=${process.platform})`,
      );
      const matched = [];
      const pushMatch = (cmd, pid) => {
        const full = String(cmd || "");
        matched.push(pid ? { pid: String(pid), cmd: full } : { cmd: full });
      };

      const timeout = setTimeout(() => {
        log.warn(
          "getServerProcessDetails: process detection timed out, cannot determine server state",
        );
        resolve({ running: false, matched: [], scanFailed: true });
      }, 10000);

      if (isWindows) {
        const powershellPath = path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const powershellScript =
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(java\\.exe|ProjectZomboid64\\.exe|ProjectZomboid32\\.exe)$' } | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation";
        execFile(
          powershellPath,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            powershellScript,
          ],
          { timeout: 8000 },
          (psError, psStdout, psStderr) => {
            clearTimeout(timeout);
            const stderr = String(psStderr || "").trim();
            if (psError || stderr) {
              const detail = [
                psError?.message,
                stderr,
              ]
                .filter(Boolean)
                .join(": ");
              log.warn(
                `getServerProcessDetails: Windows process scan failed (${detail}), cannot determine server state`,
              );
              resolve({ running: false, matched: [], scanFailed: true });
              return;
            }

            if (!psStdout) {
              this.isRunning = false;
              resolve({ running: false, matched: [] });
              return;
            }

            const ambiguous = [];
            const pushAmbiguous = (cmd) => {
              ambiguous.push(String(cmd || "").slice(0, 240));
            };
            const lines = psStdout.split(/\r?\n/);
            for (let raw of lines) {
              raw = raw.trim();
              if (!raw || raw.startsWith('"ProcessId"')) continue;
              const csvMatch = raw.match(/^"([^"]*)","((?:[^"]|"")*)"$/);
              if (!csvMatch) continue;
              const pid = csvMatch[1];
              const cmd = csvMatch[2].replace(/""/g, '"');
              if (!cmd) continue;
              if (isWindowsDedicatedServerCommandLine(cmd)) {
                log.debug(
                  `getServerProcessDetails: matched PZ server process pid=${pid}: ${cmd.substring(0, 200)}`,
                );
                pushMatch(cmd, pid);
              } else if (looksLikeUndeterminedJvmCandidate(cmd)) {
                log.debug(
                  `getServerProcessDetails: Windows candidate ignored (not a recognized dedicated-server shape, but JVM-shaped and zomboid-adjacent -- treating as ambiguous): ${cmd.substring(0, 200)}`,
                );
                pushAmbiguous(cmd);
              }
            }

            if (matched.length === 0 && ambiguous.length > 0) {
              log.warn(
                `getServerProcessDetails: found ${ambiguous.length} JVM-shaped process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
              );
              resolve({ running: false, matched: [], scanFailed: true });
              return;
            }

            this.isRunning = matched.length > 0;
            resolve({ running: matched.length > 0, matched, ambiguous });
          },
        );
      } else {
        log.debug("getServerProcessDetails: trying pgrep -af first...");
        const ambiguous = [];
        const pushAmbiguous = (cmd) => {
          ambiguous.push(String(cmd || "").slice(0, 240));
        };
        exec(
          'pgrep -af "[Zz]omboid|[Zz]ombie\\.network"',
          { timeout: 8000 },
          (pgrepErr, pgrepOut) => {
            if (!pgrepErr && pgrepOut && pgrepOut.trim()) {
              for (const line of pgrepOut.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const m = trimmed.match(/^(\d+)\s+(.*)$/);
                const pid = m ? m[1] : undefined;
                const cmd = m ? m[2] : trimmed;
                if (pid && Number(pid) === process.pid) continue;
                if (isLinuxDedicatedServerCommandLine(cmd)) {
                  pushMatch(cmd, pid);
                } else if (looksLikeUndeterminedJvmCandidate(cmd)) {
                  log.debug(
                    `getServerProcessDetails: pgrep candidate ignored (not a recognized dedicated-server shape, but JVM-shaped and zomboid-adjacent -- treating as ambiguous): ${cmd.substring(0, 200)}`,
                  );
                  pushAmbiguous(cmd);
                } else {
                  log.debug(
                    `getServerProcessDetails: pgrep candidate discarded (zomboid-adjacent but not JVM-shaped -- not evidence): ${cmd.substring(0, 200)}`,
                  );
                }
              }
              log.debug(
                `getServerProcessDetails: pgrep matched ${matched.length} confirmed / ${ambiguous.length} ambiguous process(es)`,
              );
              clearTimeout(timeout);
              if (matched.length === 0 && ambiguous.length > 0) {
                log.warn(
                  `getServerProcessDetails: found ${ambiguous.length} JVM-shaped process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched, ambiguous });
              return;
            }
            log.debug(
              "getServerProcessDetails: pgrep failed or empty, falling back to ps aux -ww",
            );
            exec("ps aux -ww", { timeout: 8000 }, (err, stdout) => {
              clearTimeout(timeout);
              if (err || !stdout) {
                log.warn(
                  `getServerProcessDetails: ps aux scan failed (${err ? err.message : "empty output"}), cannot determine server state`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              for (const line of stdout.split(/\r?\n/)) {
                const lower = line.toLowerCase();
                if (!looksZomboidAdjacent(lower)) continue;
                if (
                  /\b(ps|pgrep|grep)\b.*\b(zombie|zomboid|projectzomboid)/.test(
                    lower,
                  ) &&
                  !lower.includes("java") &&
                  !lower.includes("-server")
                ) {
                  continue;
                }
                const m = line
                  .trim()
                  .match(
                    /^\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/,
                  );
                const pid = m ? m[1] : undefined;
                const cmd = m ? m[2] : line.trim();
                if (pid && Number(pid) === process.pid) continue;
                if (isLinuxDedicatedServerCommandLine(cmd)) {
                  pushMatch(cmd, pid);
                } else if (looksLikeUndeterminedJvmCandidate(cmd)) {
                  pushAmbiguous(cmd);
                }
              }
              if (matched.length === 0 && ambiguous.length > 0) {
                log.warn(
                  `getServerProcessDetails: found ${ambiguous.length} JVM-shaped process(es) mentioning zomboid/zombie.network that don't match a known dedicated-server launch shape -- cannot confirm the server is stopped (first: ${ambiguous[0]})`,
                );
                resolve({ running: false, matched: [], scanFailed: true });
                return;
              }
              this.isRunning = matched.length > 0;
              resolve({ running: matched.length > 0, matched, ambiguous });
            });
          },
        );
      }
    });
  }

  _pidFilePath() {
    const safeName = String(this.serverName || "default").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    return path.join(getDataPaths().dataDir, `server-process-${safeName}.json`);
  }

  _writePidFile(pid) {
    try {
      const data = {
        pid: String(pid),
        serverName: this.serverName,
        writtenAt: Date.now(),
      };
      fs.writeFileSync(this._pidFilePath(), JSON.stringify(data), "utf-8");
    } catch (e) {
      log.debug(`Could not write server pidfile: ${e.message}`);
    }
  }

  _readPidFile() {
    try {
      const raw = fs.readFileSync(this._pidFilePath(), "utf-8");
      const data = JSON.parse(raw);
      if (!data || !/^\d+$/.test(String(data.pid))) return null;
      return data;
    } catch {
      return null;
    }
  }

  _deletePidFile() {
    try {
      fs.unlinkSync(this._pidFilePath());
    } catch {
      /* already absent — fine, this is best-effort cleanup */
    }
  }

  _getLiveCommandLine(pid) {
    if (!/^\d+$/.test(String(pid || ""))) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), 3000);

      if (isWindows) {
        const psCmd = `powershell -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine"`;
        exec(psCmd, { timeout: 2500 }, (err, stdout) => {
          clearTimeout(timeout);
          finish(err ? null : String(stdout || "").trim() || null);
        });
      } else {
        execFile(
          "ps",
          ["-ww", "-o", "cmd=", "-p", String(pid)],
          { timeout: 2500 },
          (err, stdout) => {
            clearTimeout(timeout);
            finish(err ? null : String(stdout || "").trim() || null);
          },
        );
      }
    });
  }

  async _tryPidFileFastPath() {
    const recorded = this._readPidFile();
    if (!recorded) return null;

    const cmd = await this._getLiveCommandLine(recorded.pid);
    if (!cmd) return null;

    const looksLikeDedicatedServer = isWindows
      ? isWindowsDedicatedServerCommandLine(cmd)
      : isLinuxDedicatedServerCommandLine(cmd);
    if (!looksLikeDedicatedServer) return null;

    const score = scoreServerProcessOwnership(
      cmd,
      this._getOwnershipDescriptor(),
    );
    if (score <= 0) return null;

    log.debug(
      `getServerProcessDetails: pidfile fast path hit for pid=${recorded.pid}, skipping full scan`,
    );
    this.isRunning = true;
    const entry = { pid: String(recorded.pid), cmd: String(cmd) };
    return {
      running: true,
      matched: [{ pid: entry.pid, cmd: entry.cmd.slice(0, 240) }],
      owned: [entry],
      scanFailed: false,
    };
  }

  async getProcessUptimeSeconds(pid) {
    if (isWindows || !/^\d+$/.test(String(pid || ""))) return null;

    return new Promise((resolve) => {
      execFile(
        "ps",
        ["-o", "etimes=", "-p", String(pid)],
        { timeout: 3000 },
        (error, stdout) => {
          if (error) return resolve(null);
          const seconds = Number.parseInt(stdout.trim(), 10);
          resolve(Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
        },
      );
    });
  }

  async startServer({ skipRunningCheck = false, serverId = this._serverId } = {}) {
    if (this._starting) {
      throw new Error("Server start already in progress");
    }
    if (this._stopping) {
      throw new Error("Server stop in progress, try again in a moment");
    }
    this._starting = true;

    try {
      if (serverId !== this._serverId) this.configLoaded = false;
      await this.loadConfig(serverId);

      const installPathForSteamCheck =
        this._serverRecord?.installPath || this.serverPath;
      if (installPathForSteamCheck) {
        const normalizedInstallPath = path
          .normalize(installPathForSteamCheck)
          .toLowerCase();
        if (hasActiveSteamOperation(normalizedInstallPath)) {
          throw new Error(
            "A Steam install or update is currently in progress for this server's install directory. Wait for it to finish before starting the server.",
          );
        }
      }

      if (this.usesManagedServiceLifecycle()) {
        const result = await this._getManagedLifecycle().run("start");
        if (!result.success) throw new Error(result.error || result.message);
        this.serverProcess = null;
        this.isRunning = true;
        this.startTime = this.startTime || new Date();
        this._deletePidFile();
        await logServerEvent(
          "server_start",
          `Server started through ${this.lifecycleProvider}`,
        ).catch((error) => log.warn(`Failed to log event: ${error.message}`));
        return result;
      }

      if (!this.startCommand && !this.serverPath) {
        throw new Error("Server path not configured");
      }

      if (!skipRunningCheck) {
        const processDetails = await this.getServerProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          throw new Error(
            "Could not confirm the server is stopped because process detection failed",
          );
        }
        if (processDetails.running) {
          throw new Error("Server is already running");
        }

        const configuredRconPort =
          this.rconPort ?? (await getSetting("rconPort"));
        const rconPort = resolveConfiguredRconPort(configuredRconPort);
        if (rconPort === null) {
          throw new Error("Invalid RCON port configuration");
        }
        const rconHost =
          this.rconHost || (await getSetting("rconHost")) || "127.0.0.1";
        const portInUse = await new Promise((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(2000);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
          try {
            socket.connect(rconPort, rconHost);
          } catch {
            resolve(false);
          }
        });
        if (portInUse) {
          throw new Error(
            `RCON port ${rconHost}:${rconPort} is already in use — a server may be running that process detection missed. Aborting start to prevent port conflict.`,
          );
        }
      }

      if (this.isJvmExecutableBusy()) {
        for (let attempt = 0; attempt < 10 && this.isJvmExecutableBusy(); attempt++) {
          await this.sleep(300);
        }
      }

      log.info(
        `Starting server process (platform=${process.platform}, serverPath=${this.serverPath}, startCommand=${this.startCommand || "none"}, serverBat=${this.serverBat})`,
      );

      if (this.startCommand) {
        const validation = validateStartCommand(this.startCommand);
        if (!validation.valid) {
          throw new Error(`Invalid start command: ${validation.reason}`);
        }

        const { cmd, args } = parseCustomStartCommand(this.startCommand);
        const cwd = this.serverPath || path.dirname(path.resolve(cmd));

        const ext = path.extname(cmd).toLowerCase();
        if (!ALLOWED_CMD_EXTENSIONS.includes(ext)) {
          throw new Error(
            `Start command has disallowed extension '${ext}'. Allowed: ${ALLOWED_CMD_EXTENSIONS.join(", ")}`,
          );
        }

        const resolvedCmd = path.isAbsolute(cmd) ? cmd : path.resolve(cwd, cmd);
        if (!fs.existsSync(resolvedCmd)) {
          throw new Error(`Start command not found: ${resolvedCmd}`);
        }

        log.info(
          `Using custom start command: ${resolvedCmd} ${args.join(" ")} (ext=${ext}, cwd=${cwd})`,
        );

        const launchLogPath = this._openLaunchLog();
        const launchStdio = ["ignore", this._launchLogFd, this._launchLogFd];

        if (isWindows && (ext === ".bat" || ext === ".cmd")) {
          this._closeLaunchLogFd();
          const commandLine = buildWindowsCmdLine(
            resolvedCmd,
            args,
            launchLogPath,
          );
          this.serverProcess = spawn("cmd.exe", ["/c", commandLine], {
            cwd,
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          });
        } else if (!isWindows && ext === ".sh") {
          try {
            fs.chmodSync(resolvedCmd, 0o750);
          } catch (e) {
            log.debug(`chmod on custom .sh failed: ${e.message}`);
          }
          const serverAbsPath = path.resolve(cwd);
          const ldPath = buildLdLibraryPath(serverAbsPath);
          log.debug(
            `Spawning custom .sh: bash ${resolvedCmd} ${args.join(" ")} (cwd=${cwd}, LD_LIBRARY_PATH=${ldPath})`,
          );
          this.serverProcess = spawn("bash", [resolvedCmd, ...args], {
            cwd,
            detached: true,
            stdio: launchStdio,
            env: { ...process.env, LD_LIBRARY_PATH: ldPath },
          });
        } else {
          if (!isWindows) {
            try {
              fs.chmodSync(resolvedCmd, 0o750);
            } catch (e) {
              log.debug(`chmod on custom command failed: ${e.message}`);
            }
          }
          const spawnEnv = isWindows
            ? process.env
            : (() => {
                const serverAbsPath = path.resolve(cwd);
                return {
                  ...process.env,
                  LD_LIBRARY_PATH: buildLdLibraryPath(serverAbsPath),
                };
              })();
          this.serverProcess = spawn(resolvedCmd, args, {
            cwd,
            detached: true,
            stdio: launchStdio,
            env: spawnEnv,
          });
        }
        this._closeLaunchLogFd();

        this.serverProcess.on("error", (error) => {
          log.error(`Server process error: ${error.message}`);
          this.isRunning = false;
          this.serverProcess = null;
        });

        this.serverProcess.unref();
        this.isRunning = true;
        this.startTime = new Date();

        const crash = await this._waitForImmediateCrash(launchLogPath);
        if (crash) {
          this.isRunning = false;
          this.serverProcess = null;
          throw new Error(
            `Server process exited immediately after starting (code=${crash.exitCode}, signal=${crash.signal || "none"}) — startup failed.${crash.tail ? `\n${crash.tail}` : ""}`,
          );
        }

        await logServerEvent("server_start", "Server started via manager");
        log.info("Server start command executed");
        this._writePidFile(this.serverProcess.pid);

        return { success: true, message: "Server start command executed" };
      }

      const batPath = path.join(this.serverPath, this.serverBat);

      if (!fs.existsSync(batPath)) {
        throw new Error(`Server startup script not found: ${batPath}`);
      }

      const launchLogPath = this._openLaunchLog();
      const launchStdio = ["ignore", this._launchLogFd, this._launchLogFd];

      if (isWindows) {
        this._closeLaunchLogFd();
        const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
        this.serverProcess = spawn("cmd.exe", ["/c", commandLine], {
          cwd: this.serverPath,
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        });
      } else {
        try {
          fs.chmodSync(batPath, 0o750);
        } catch (e) {
          log.warn(`Could not chmod startup script: ${e.message}`);
        }
        const serverAbsPath = path.resolve(this.serverPath);
        const ldPath = buildLdLibraryPath(serverAbsPath);
        log.debug(
          `Spawning default .sh: bash ${this.serverBat} (cwd=${this.serverPath}, LD_LIBRARY_PATH=${ldPath})`,
        );

        this.serverProcess = spawn("bash", [this.serverBat], {
          cwd: this.serverPath,
          detached: true,
          stdio: launchStdio,
          env: { ...process.env, LD_LIBRARY_PATH: ldPath },
        });
      }
      this._closeLaunchLogFd();

      this.serverProcess.on("error", (error) => {
        log.error(`Server process error: ${error.message}`);
        this.isRunning = false;
        this.serverProcess = null;
      });

      this.serverProcess.unref();
      this.isRunning = true;
      this.startTime = new Date();

      const crash = await this._waitForImmediateCrash(launchLogPath);
      if (crash) {
        this.isRunning = false;
        this.serverProcess = null;
        throw new Error(
          `Server process exited immediately after starting (code=${crash.exitCode}, signal=${crash.signal || "none"}) — startup failed.${crash.tail ? `\n${crash.tail}` : ""}`,
        );
      }

      await logServerEvent("server_start", "Server started via manager");
      log.info("Server start command executed");
      this._writePidFile(this.serverProcess.pid);

      return { success: true, message: "Server start command executed" };
    } finally {
      this._starting = false;
    }
  }

  _openLaunchLog() {
    const launchLogPath = path.join(
      getDataPaths().logsDir,
      "server-launch.log",
    );
    try {
      this._launchLogFd = fs.openSync(launchLogPath, "w");
      return launchLogPath;
    } catch (e) {
      log.debug(`Could not open launch log file: ${e.message}`);
      this._launchLogFd = "ignore";
      return null;
    }
  }

  _closeLaunchLogFd() {
    if (typeof this._launchLogFd === "number") {
      try {
        fs.closeSync(this._launchLogFd);
      } catch {
        /* already closed */
      }
    }
    this._launchLogFd = null;
  }

  _waitForImmediateCrash(launchLogPath) {
    const proc = this.serverProcess;
    if (!proc) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let graceTimer;
      const readTail = () => {
        try {
          if (launchLogPath && fs.existsSync(launchLogPath)) {
            return fs.readFileSync(launchLogPath, "utf-8").slice(-2000).trim();
          }
        } catch {
          /* best effort */
        }
        return "";
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        proc.removeListener("exit", onExit);
        proc.removeListener("error", onError);
        resolve(result);
      };
      const onExit = (exitCode, signal) => {
        finish({ exitCode, signal, tail: readTail() });
      };
      const onError = (error) => {
        finish({
          exitCode: null,
          signal: null,
          tail: `spawn error: ${error.message}`,
        });
      };
      proc.once("exit", onExit);
      proc.once("error", onError);
      graceTimer = setTimeout(() => finish(null), 4000);
    });
  }

  async stopServer(
    graceful = true,
    { serverId = this._serverId } = {},
  ) {
    if (graceful) {
      log.info("Graceful stop requested - use RCON quit command");
      return {
        success: true,
        message: "Use RCON quit command for graceful shutdown",
      };
    }

    if (this._stopping) {
      return {
        success: false,
        confirmed: false,
        error: "Stop already in progress",
        message:
          "A stop or force-stop is already in progress for this server. Wait for it to finish, then try again.",
      };
    }

    this._stopping = true;
    try {
      if (serverId !== this._serverId) this.configLoaded = false;
      await this.loadConfig(serverId);
      if (this.usesManagedServiceLifecycle()) {
        const result = await this._getManagedLifecycle().run("stop");
        if (result.success && result.confirmed !== false) this._clearRunState();
        if (result.success) {
          await logServerEvent(
            "server_stop",
            `Server stopped through ${this.lifecycleProvider}`,
          ).catch((error) => log.warn(`Failed to log event: ${error.message}`));
        }
        return result;
      }
      const details = await this.getServerProcessDetails();
      const pids = (details.owned || [])
        .map((entry) => entry.pid)
        .filter((pid) => /^\d+$/.test(String(pid ?? "")))
        .map(String);

      if (pids.length > 0) {
        log.info(
          `stopServer: force killing PID(s) for "${this.serverName}": ${pids.join(", ")}`,
        );
        const launcher = this.serverProcess;
        if (
          !isWindows &&
          launcher?.pid &&
          launcher.killed !== true &&
          launcher.exitCode === null
        ) {
          const groupResult = this._killProcessGroup(launcher.pid);
          if (groupResult.failed) {
            log.debug(
              `stopServer: launcher process-group kill failed: ${groupResult.errors.join("; ")}`,
            );
          }
        }
        const killResult = await this._killPids(pids);
        const { timedOut, failed, errors = [] } = killResult;
        if (timedOut) {
          log.warn(
            `stopServer: kill command for "${this.serverName}" (PIDs: ${pids.join(", ")}) did not finish within ${this._killTimeoutMs}ms — could not confirm the process actually exited`,
          );
          await logServerEvent(
            "server_stop",
            `Server stop timed out waiting for kill confirmation (PIDs: ${pids.join(", ")})`,
          ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
          return {
            success: true,
            confirmed: false,
            timedOut: true,
            message:
              "Stop signal sent, but confirmation timed out — check whether the server actually exited before starting it again",
          };
        }
        if (failed) {
          const errorMessage = errors.join("; ") || "kill command failed";
          log.error(
            `stopServer: could not stop "${this.serverName}": ${errorMessage}`,
          );
          return {
            success: false,
            confirmed: false,
            error: errorMessage,
            message: "The server could not be stopped.",
          };
        }
        if (!(await this._confirmProcessStopped())) {
          return {
            success: true,
            confirmed: false,
            timedOut: true,
            message:
              "Stop signal sent, but the server is still running or its exit could not be confirmed",
          };
        }
        this._clearRunState();
        await logServerEvent(
          "server_stop",
          `Server force stopped (killed PIDs: ${pids.join(", ")})`,
        ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
        return { success: true, message: "Server stopped" };
      }

      if (!details.scanFailed) {
        log.debug(
          `stopServer: no running process belongs to "${this.serverName}"`,
        );
        this._clearRunState();
        return { success: true, message: "Server was not running" };
      }

      if (!(await this._isOnlyLocalServer())) {
        throw new Error(
          "Process detection failed and more than one server is configured on this host — force stop aborted rather than risk killing the wrong server. Stop it from its own console window.",
        );
      }

      log.warn(
        "stopServer: process detection failed. Falling back to generic force stop.",
      );
      const forceResult = await this._genericForceStop();
      const { timedOut, failed, errors = [] } = forceResult;
      if (timedOut) {
        log.warn(
          `stopServer: generic force stop did not finish within ${this._killTimeoutMs}ms — could not confirm the process actually exited`,
        );
        await logServerEvent(
          "server_stop",
          "Server stop timed out waiting for kill confirmation (generic fallback)",
        ).catch((e) => log.warn(`Failed to log event: ${e.message}`));
        return {
          success: true,
          confirmed: false,
          timedOut: true,
          message:
            "Stop signal sent, but confirmation timed out — check whether the server actually exited before starting it again",
        };
      }
      if (failed) {
        const errorMessage = errors.join("; ") || "force-stop command failed";
        log.error(`stopServer: generic force stop failed: ${errorMessage}`);
        return {
          success: false,
          confirmed: false,
          error: errorMessage,
          message: "The server could not be force-stopped.",
        };
      }
      if (!(await this._confirmProcessStopped())) {
        return {
          success: true,
          confirmed: false,
          timedOut: true,
          message:
            "Stop signal sent, but the server is still running or its exit could not be confirmed",
        };
      }
      this._clearRunState();
      await logServerEvent("server_stop", "Server force stopped").catch((e) =>
        log.warn(`Failed to log event: ${e.message}`),
      );
      return { success: true, message: "Forced fallback kill executed" };
    } finally {
      this._stopping = false;
    }
  }

  markServerStopped() {
    this._clearRunState();
  }

  _clearRunState() {
    this.isRunning = false;
    this.serverProcess = null;
    this.startTime = null;
    this._deletePidFile();
  }

  async _isOnlyLocalServer() {
    try {
      const servers = await getServers();
      return (servers || []).filter((entry) => !entry.isRemote).length <= 1;
    } catch (error) {
      log.debug(`Could not count configured servers: ${error.message}`);
      return false;
    }
  }

  _killPids(pids) {
    return new Promise((resolve) => {
      if (isWindows) {
        let remaining = pids.length;
        let timedOut = false;
        const errors = [];
        for (const pid of pids) {
          execFile(
            "taskkill",
            ["/PID", pid, "/T", "/F"],
            { timeout: this._killTimeoutMs },
            (killErr) => {
              if (killErr) {
                const outcome = classifyProcessKillError(killErr);
                if (outcome === "timedOut") timedOut = true;
                if (outcome === "failed") errors.push(`PID ${pid}: ${killErr.message}`);
                log.debug(`taskkill ${pid}: ${killErr.message}`);
              }
                if (--remaining === 0) {
                  resolve({ timedOut, failed: errors.length > 0, errors });
                }
            },
          );
        }
        return;
      }

      execFile(
        "kill",
        ["-9", ...pids],
        { timeout: this._killTimeoutMs },
        (killErr) => {
          const outcome = classifyProcessKillError(killErr);
          if (killErr && outcome !== "alreadyGone") {
            log.warn(
              `Kill returned error (may be normal if process already exited): ${killErr.message}`,
            );
          }
          resolve({
            timedOut: outcome === "timedOut",
            failed: outcome === "failed",
            errors: outcome === "failed" ? [killErr.message] : [],
          });
        },
      );
    });
  }

  _killProcessGroup(pid) {
    if (isWindows || !/^\d+$/.test(String(pid ?? "")) || Number(pid) <= 1) {
      return { failed: false, errors: [] };
    }

    try {
      process.kill(-Number(pid), "SIGKILL");
      return { failed: false, errors: [] };
    } catch (error) {
      const outcome = classifyProcessKillError(error);
      return {
        failed: outcome === "failed",
        errors: outcome === "failed" ? [error.message] : [],
      };
    }
  }

  async _confirmProcessStopped() {
    let timeoutId;
    const processDetails = Promise.resolve()
      .then(() => this.getServerProcessDetails())
      .catch(() => null);
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), 3000);
    });

    try {
      const details = await Promise.race([processDetails, timeout]);
      return Boolean(details && !details.scanFailed && details.running === false);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  _genericForceStop() {
    return new Promise((resolve) => {
      if (isWindows) {
        let timedOut = false;
        const errors = [];
        exec(
          "taskkill /IM ProjectZomboid64.exe /T /F",
          { timeout: this._killTimeoutMs },
          (err1) => {
            const outcome1 = classifyProcessKillError(err1);
            if (outcome1 === "timedOut") timedOut = true;
            if (outcome1 === "failed") errors.push(`ProjectZomboid64.exe: ${err1.message}`);
            exec(
              "powershell -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='java.exe'\\\" | Where-Object { $_.CommandLine -like '*zombie.network.gameserver*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"",
              { timeout: this._killTimeoutMs },
              (err2) => {
                const outcome2 = classifyProcessKillError(err2);
                if (outcome2 === "timedOut") timedOut = true;
                if (outcome2 === "failed") errors.push(`java.exe: ${err2.message}`);
                resolve({ timedOut, failed: errors.length > 0, errors });
              },
            );
          },
        );
        return;
      }

      exec(
        "pkill -9 -f 'zombie.network.[Gg]ame[Ss]erver|[Pp]roject[Zz]omboid64|[Pp]roject[Zz]omboid32'",
        { timeout: this._killTimeoutMs },
        (err) => {
          const outcome = classifyProcessKillError(err);
          resolve({
            timedOut: outcome === "timedOut",
            failed: outcome === "failed",
            errors: outcome === "failed" ? [err.message] : [],
          });
        },
      );
    });
  }

  async restartServer(rconService, warningMinutes = 5) {
    try {
      const sendWarning = async (msg) => {
        try {
          let timeoutId;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("RCON timeout")),
              5000,
            );
          });
          await Promise.race([rconService.serverMessage(msg), timeoutPromise]);
          clearTimeout(timeoutId);
        } catch (e) {
          log.warn(`Failed to send restart warning: ${e.message}`);
        }
      };

      const warnings = [5, 4, 3, 2, 1];
      for (const minutes of warnings) {
        if (minutes <= warningMinutes) {
          await sendWarning(`Server restarting in ${minutes} minute(s)!`);
          await this.sleep(60000);
        }
      }

      await sendWarning("Server restarting NOW!");
      await this.sleep(5000);

      try {
        let saveTimeoutId;
        const saveTimeout = new Promise((_, reject) => {
          saveTimeoutId = setTimeout(
            () => reject(new Error("Save timeout")),
            10000,
          );
        });
        const saveResult = await Promise.race([rconService.save(), saveTimeout]);
        clearTimeout(saveTimeoutId);
        if (!saveResult?.success) {
          throw new Error(
            `Save before restart failed: ${saveResult?.error || "unknown error"}`,
          );
        }
      } catch (e) {
        throw new Error(`Save before restart failed: ${e.message}`);
      }
      await this.sleep(3000);

      await this.loadConfig(this._serverId);
      if (this.usesManagedServiceLifecycle()) {
        const restarted = await this._getManagedLifecycle().run("restart");
        if (!restarted.success || restarted.confirmed === false) {
          throw new Error(
            restarted.error ||
              `${this.lifecycleProvider} did not confirm the restart`,
          );
        }
        this.serverProcess = null;
        this.isRunning = true;
        this.startTime = new Date();
        this._deletePidFile();
        await logServerEvent(
          "server_restart",
          `Server restarted through ${this.lifecycleProvider}`,
        );
        return {
          success: true,
          message: `Server restarted successfully through ${this.lifecycleProvider}`,
        };
      }

      try {
        let quitTimeoutId;
        const quitTimeout = new Promise((_, reject) => {
          quitTimeoutId = setTimeout(
            () => reject(new Error("Quit timeout")),
            10000,
          );
        });
        await Promise.race([rconService.quit(), quitTimeout]);
        clearTimeout(quitTimeoutId);
      } catch (e) {
        log.warn(`RCON quit failed, will force stop: ${e.message}`);
      }
      await this.sleep(10000);

      let processDetails = await this.getServerProcessDetails();
      if (!processDetails || processDetails.scanFailed) {
        throw new Error(
          "Could not confirm the old server stopped because process detection failed",
        );
      }
      let jvmBusy = this.isJvmExecutableBusy();
      let attempts = 0;
      while ((processDetails.running || jvmBusy) && attempts < 30) {
        await this.sleep(1000);
        attempts++;
        processDetails = await this.getServerProcessDetails();
        if (!processDetails || processDetails.scanFailed) {
          throw new Error(
            "Could not confirm the old server stopped because process detection failed",
          );
        }
        jvmBusy = this.isJvmExecutableBusy();
      }

      if (processDetails.running) {
        const forced = await this.stopServer(false);
        if (!forced?.success || forced.confirmed === false) {
          throw new Error(
            `The old server process could not be stopped (${forced?.error || "unknown error"}), so it was not restarted`,
          );
        }
        await this.sleep(5000);
        jvmBusy = this.isJvmExecutableBusy();
      }

      if (jvmBusy) {
        throw new Error(
          "The previous server process appears to have exited, but its Java executable is still locked by the kernel (\"Text file busy\") -- refusing to start a new one until it clears, to avoid a corrupted install",
        );
      }

      await this.sleep(3000);

      const started = await this.startServer({ skipRunningCheck: true });
      if (!started?.success) {
        return {
          success: false,
          message: `Server stopped but did not start again: ${started?.error || started?.message || "unknown error"}`,
        };
      }

      await logServerEvent("server_restart", "Server restarted");
      return { success: true, message: "Server restarted successfully" };
    } catch (error) {
      log.error(`Restart failed: ${error.message}`);
      throw error;
    }
  }

  async getServerStatus() {
    await this.loadConfig();

    if (!this.gamePort) {
      this.loadGamePort().catch((err) =>
        log.debug(`Failed to load game port: ${err.message}`),
      );
    }
    const configuredWanIp = getConfiguredIpv4Address("PANEL_WAN_IP");
    if (configuredWanIp) {
      this.publicIp = configuredWanIp;
    } else if (!this.fetchingIp) {
      try {
        const enabled = await getSetting("enablePublicIpLookup");
        if (enabled === true || enabled === "true") {
          const cached = await getSetting("cachedPublicIp");
          const cachedAt = Number(await getSetting("cachedPublicIpAt")) || 0;
          const isStale = Date.now() - cachedAt > PUBLIC_IP_CACHE_TTL_MS;
          if (cached && !isStale) {
            this.publicIp = cached;
          } else {
            this.fetchPublicIp().catch((err) =>
              log.debug(`Failed to fetch public IP: ${err.message}`),
            );
          }
        }
      } catch (err) {
        log.debug(`Public IP lookup setting check failed: ${err.message}`);
      }
    }

    const processDetails = await this.getServerProcessDetails();
    const isRunning = processDetails.running;
    if (!isRunning && !processDetails.scanFailed) {
      this._clearRunState();
    }
    if (isRunning && !this.startTime) {
      const detectedUptime = await this.getProcessUptimeSeconds(
        processDetails.matched[0]?.pid,
      );
      if (detectedUptime != null) {
        this.startTime = new Date(Date.now() - detectedUptime * 1000);
      }
    }

    const uptimeMs = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    return {
      running: isRunning,
      scanFailed: Boolean(processDetails.scanFailed),
      startTime: this.startTime,
      uptime: uptimeSeconds,
      serverPath: this.serverPath,
      serverPathConfigured: !!this.serverPath,
      publicIp: this.publicIp,
      localIp: await this.getLocalIp(),
      port: this.gamePort,
    };
  }

  usesManagedServiceLifecycle() {
    return (
      isManagedLifecycleProvider(this.lifecycleProvider) &&
      Boolean(this._serverRecord)
    );
  }

  _getManagedLifecycle() {
    if (!this.usesManagedServiceLifecycle()) {
      throw new Error("No managed service lifecycle is configured");
    }
    return this._lifecycleFactory(
      this._serverRecord,
      this.lifecycleProvider,
    );
  }

  listNetworkInterfaces() {
    const interfaces = os.networkInterfaces();
    const result = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          result.push({ name, address: iface.address });
        }
      }
    }
    return result;
  }

  async getLocalIp() {
    const interfaces = this.listNetworkInterfaces();

    try {
      const selected = await getSetting("lanIpAddress");
      if (selected && interfaces.some((iface) => iface.address === selected)) {
        return selected;
      }
    } catch (err) {
      log.debug(`lanIpAddress setting lookup failed: ${err.message}`);
    }

    const configuredLanIp = getConfiguredIpv4Address("PANEL_LAN_IP");
    if (configuredLanIp) return configuredLanIp;

    return interfaces[0]?.address || "127.0.0.1";
  }

  async loadGamePort() {
    try {
      const config = await this.getServerConfig();
      if (config && config.DefaultPort) {
        this.gamePort = parseInt(config.DefaultPort, 10);
      }
    } catch (e) {
      // ignore
    }
  }

  async fetchPublicIp() {
    if (this.fetchingIp) return;
    this.fetchingIp = true;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch("https://api.ipify.org?format=json", {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        this.publicIp = data.ip;
        try {
          await setSetting("cachedPublicIp", data.ip);
          await setSetting("cachedPublicIpAt", String(Date.now()));
        } catch (_) {
          /* best effort */
        }
      }
    } catch (e) {
      // silent fail
    } finally {
      this.fetchingIp = false;
    }
  }

  async getServerConfig() {
    await this.loadConfig();

    if (!this.savePath) {
      return null;
    }

    const serverConfigDir = path.join(this.savePath, "Server");
    const serverNameIniPath = path.join(
      serverConfigDir,
      `${this.serverName}.ini`,
    );

    if (fs.existsSync(serverNameIniPath)) {
      log.debug(`Reading config from ${serverNameIniPath}`);
      return this.parseIniFile(serverNameIniPath);
    }

    const configPath = path.join(this.savePath, `${this.serverName}.ini`);
    if (fs.existsSync(configPath)) {
      log.debug(`Reading config from fallback ${configPath}`);
      return this.parseIniFile(configPath);
    }

    const legacyPath = path.join(this.savePath, "servertest.ini");
    if (fs.existsSync(legacyPath)) {
      log.debug(`Reading config from legacy ${legacyPath}`);
      return this.parseIniFile(legacyPath);
    }

    const altPath = path.join(this.savePath, "serveroptions.ini");
    if (fs.existsSync(altPath)) {
      return this.parseIniFile(altPath);
    }

    log.warn(
      `No config file found. Tried: ${serverNameIniPath}, ${configPath}, ${legacyPath}`,
    );
    return null;
  }

  parseIniFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const config = {};
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith(";")) {
          const [key, ...valueParts] = trimmed.split("=");
          if (key && valueParts.length > 0) {
            config[key.trim()] = valueParts.join("=").trim();
          }
        }
      }

      return config;
    } catch (error) {
      log.error(`Failed to parse config file: ${error.message}`);
      return null;
    }
  }

  async saveServerConfig(config) {
    if (!this.savePath) {
      throw new Error("Save path not configured");
    }

    const serverIni = this.serverName
      ? `${this.serverName}.ini`
      : "servertest.ini";
    const serverSubdirPath = path.join(this.savePath, "Server", serverIni);
    let configPath;
    if (fs.existsSync(serverSubdirPath)) {
      configPath = serverSubdirPath;
    } else {
      configPath = path.join(this.savePath, serverIni);
      if (!fs.existsSync(configPath)) {
        configPath = path.join(this.savePath, "servertest.ini");
      }
    }

    try {
      await withFileLock(configPath, async () => {
        let content = "";
        if (fs.existsSync(configPath)) {
          content = fs.readFileSync(configPath, "utf-8");
        }

        for (const [key, value] of Object.entries(config)) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            log.warn(`Invalid config key skipped: ${key}`);
            continue;
          }
          const escapedKey = escapeRegExp(key);
          const regex = new RegExp(`^[ \\t]*${escapedKey}[ \\t]*=.*$`, "m");
          const safeValue = String(value).replace(/[\r\n]/g, "");
          if (content.match(regex)) {
            content = content.replace(regex, `${key}=${safeValue}`);
          } else {
            content += `\n${key}=${safeValue}`;
          }
        }

        writeFileAtomic(configPath, content, "utf-8");

        const writtenBack = fs.readFileSync(configPath, "utf-8");
        if (writtenBack !== content) {
          throw new Error(
            `Config write verification failed: ${configPath} does not match the intended content after write`,
          );
        }
      });
      log.info("Server config saved");
      return { success: true };
    } catch (error) {
      log.error(`Failed to save config: ${error.message}`);
      throw error;
    }
  }

  async getModList() {
    if (!this.savePath) {
      return [];
    }

    try {
      const config = await this.getServerConfig();
      if (!config || !config.Mods) {
        return [];
      }

      const mods = config.Mods.split(";").filter((m) => m.trim());
      const workshopIds = config.WorkshopItems
        ? config.WorkshopItems.split(";").filter((m) => m.trim())
        : [];

      return mods.map((mod, index) => ({
        name: mod,
        workshopId: workshopIds[index] || null,
      }));
    } catch (error) {
      log.error(`Failed to get mod list: ${error.message}`);
      return [];
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updatePaths(serverPath, savePath) {
    this.serverPath = serverPath || this.serverPath;
    this.savePath = savePath || this.savePath;
  }
}

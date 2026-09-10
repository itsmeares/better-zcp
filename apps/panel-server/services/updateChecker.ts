import { spawn, type SpawnOptions } from "child_process";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("Updates");
import { getSetting, setSetting, getActiveServer } from "../database/init.ts";
import { resolveManagedContainer } from "./managedContainer.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import {
  hasActiveSteamOperation,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  isSteamOperationIdle,
  STEAM_OPERATION_IDLE_TIMEOUT_MS,
} from "./activeSteamOperations.ts";
import { acquireLifecycleLock } from "./lifecycleCoordinator.ts";
import { buildLinuxWritableHomeEnv } from "../utils/steamEnvironment.ts";

type UpdateSocket = {
  emit: (event: string, payload: unknown) => void;
};

type CommandResult = {
  success?: boolean;
  error?: string;
  message?: string;
};

type RconService = {
  connected?: boolean;
  serverMessage: (message: string, options?: { skipLog?: boolean }) => Promise<CommandResult>;
  save: (options?: { skipLog?: boolean }) => Promise<CommandResult>;
  quit: () => Promise<CommandResult>;
};

type ServerProcessDetails = {
  running: boolean;
  scanFailed?: boolean;
};

type ServerManager = {
  serverName?: string | null;
  getServerProcessDetails: () => Promise<ServerProcessDetails>;
  startServer: (options?: {
    skipRunningCheck?: boolean;
    serverId?: string | null;
  }) => Promise<CommandResult>;
};

type UpdateCheckerOptions = {
  rconService?: RconService;
  serverManager?: ServerManager;
};

type InstalledBuildInfo = {
  buildId: string | null;
  branch: string;
  lastUpdated: string | null;
};

type LatestBuildInfo = {
  branch: string;
  buildId: string | null;
  timeUpdated: string | null;
  description: string | null;
};

type UpdateInfo = {
  updateAvailable: boolean;
  installed: InstalledBuildInfo;
  latest: LatestBuildInfo;
  lastCheck: string;
};

type AutoUpdateResult = {
  status: "success" | "failed";
  at: string;
  dismissed: boolean;
  appliedVersion?: string | null;
  reason?: string;
  params?: unknown;
  phase?: string;
  serverUp?: boolean | null;
};

type AutoUpdateResultInput = Omit<AutoUpdateResult, "dismissed">;

class AutoUpdateError extends Error {
  autoUpdateReason?: string;
  autoUpdateParams?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return "unknown";
}

export function parseAutoUpdateWarningMinutes(value: unknown): number {
  if (value === null || value === undefined) return 15;
  if (typeof value === "string" && value.trim() === "") return 15;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15;
  return Math.min(60, Math.max(0, Math.floor(parsed)));
}

async function getSteamLoginArgs() {
  const account = String((await getSetting("steamUpdateAccount")) || "").trim();
  return ["+login", account || "anonymous"];
}

export class UpdateChecker {
  io: UpdateSocket;
  rconService?: RconService;
  serverManager?: ServerManager;
  checkInterval: ReturnType<typeof setInterval> | null;
  lastCheck: string | null;
  updateAvailable: UpdateInfo | null;
  gameVersion: string | null;
  isChecking: boolean;
  initialTimeout: ReturnType<typeof setTimeout> | null;
  autoUpdateTimer: ReturnType<typeof setTimeout> | null;
  autoUpdateRunning: boolean;
  intervalMs: number;
  checkStartTime: number | null;
  lastAutoUpdateResult: AutoUpdateResult | null | undefined;

  constructor(io: UpdateSocket, { rconService, serverManager }: UpdateCheckerOptions = {}) {
    this.io = io;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.checkInterval = null;
    this.lastCheck = null;
    this.updateAvailable = null;
    this.gameVersion = null;
    this.isChecking = false;
    this.autoUpdateTimer = null;
    this.autoUpdateRunning = false;

    this.intervalMs = 30 * 60 * 1000;
    this.initialTimeout = null;
    this.checkStartTime = null;
    this.lastAutoUpdateResult = undefined;
  }

  async start(): Promise<void> {
    const interval = await getSetting("updateCheckInterval");
    if (interval && interval > 0) {
      this.intervalMs = interval * 60 * 1000;
    }

    this.initialTimeout = setTimeout(() => this.checkForUpdates(), 60 * 1000);

    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, this.intervalMs);

    log.info(`started (checking every ${this.intervalMs / 60000} minutes)`);
  }

  stop(): void {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer);
      this.autoUpdateTimer = null;
    }
    log.info("stopped");
  }

  async setInterval(minutes: number): Promise<void> {
    if (minutes < 5) minutes = 5;
    if (minutes > 1440) minutes = 1440;

    this.intervalMs = minutes * 60 * 1000;
    await setSetting("updateCheckInterval", minutes);

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = setInterval(() => {
        this.checkForUpdates();
      }, this.intervalMs);
    }

    log.info(`interval set to ${minutes} minutes`);
  }

  async getGameVersion(): Promise<string | null> {
    let consolePath = null;
    try {
      const activeServer = await getActiveServer();
      const dataPath =
        activeServer?.zomboidDataPath || (await getSetting("zomboidDataPath"));
      if (!dataPath) return null;

      consolePath = path.join(dataPath, "server-console.txt");
      await fs.promises.access(consolePath);

      const fd = await fs.promises.open(consolePath, "r");
      const buf = Buffer.alloc(512);
      await fd.read(buf, 0, 512, 0);
      await fd.close();

      const firstLine = buf.toString("utf8").split(/\r?\n/)[0];
      const match = firstLine.match(/version=(\d+\.\d+(?:\.\d+)?)/);
      return match ? match[1] : null;
    } catch (e) {
      log.debug(
        `Failed to read PZ version from ${consolePath || "(unset)"}: ${errorMessage(e)}`,
      );
      return null;
    }
  }

  async getInstalledBuildInfo(serverPath: string): Promise<InstalledBuildInfo | null> {
    const manifestPath = path.join(
      serverPath,
      "steamapps",
      "appmanifest_380870.acf",
    );

    try {
      await fs.promises.access(manifestPath);
    } catch (e) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(manifestPath, "utf8");

      const buildIdMatch = content.match(/"buildid"\s+"(\d+)"/);
      const betaKeyMatch = content.match(/"BetaKey"\s+"([^"]+)"/);
      const lastUpdatedMatch = content.match(/"LastUpdated"\s+"(\d+)"/);

      return {
        buildId: buildIdMatch ? buildIdMatch[1] : null,
        branch: betaKeyMatch ? betaKeyMatch[1] : "public",
        lastUpdated: lastUpdatedMatch
          ? new Date(parseInt(lastUpdatedMatch[1], 10) * 1000).toISOString()
          : null,
      };
    } catch (err) {
      log.error(`Failed to read appmanifest: ${errorMessage(err)}`);
      return null;
    }
  }

  async getLatestBuildInfo(
    steamcmdPath: string,
    branch = "public",
    installPath: string | null = null,
  ): Promise<LatestBuildInfo | null> {
    let steamcmdExe: string | undefined;
    if (process.platform === "win32") {
      steamcmdExe = path.join(steamcmdPath, "steamcmd.exe");
    } else {
      const shPath = path.join(steamcmdPath, "steamcmd.sh");
      const binPath = path.join(steamcmdPath, "steamcmd");
      try {
        await fs.promises.access(shPath);
        steamcmdExe = shPath;
      } catch (e1) {
        log.debug(`SteamCMD not at ${shPath}: ${errorMessage(e1)}`);
        try {
          await fs.promises.access(binPath);
          steamcmdExe = binPath;
        } catch (e2) {
          log.debug(`SteamCMD not at ${binPath}: ${errorMessage(e2)}`);
          for (const sysPath of [
            "/usr/games/steamcmd",
            "/usr/bin/steamcmd",
            "/usr/local/bin/steamcmd",
          ]) {
            try {
              await fs.promises.access(sysPath);
              steamcmdExe = sysPath;
              break;
            } catch (e3) {
              log.debug(`SteamCMD not at ${sysPath}: ${errorMessage(e3)}`);
            }
          }
          if (!steamcmdExe) {
            log.warn(
              `SteamCMD not found at: ${shPath}, ${binPath}, /usr/games/steamcmd`,
            );
            throw new Error("SteamCMD not found");
          }
        }
      }
      log.debug(`Using SteamCMD executable: ${steamcmdExe}`);
    }

    try {
      if (!steamcmdExe) throw new Error("SteamCMD not found");
      await fs.promises.access(steamcmdExe);
    } catch (e) {
      throw new Error("SteamCMD not found");
    }

    let normalizedInstallPath = null;
    if (installPath) {
      normalizedInstallPath = path.normalize(installPath).toLowerCase();
      if (hasActiveSteamOperation(normalizedInstallPath)) {
        throw new Error(
          "A Steam install or update is already in progress for this server's install directory. Skipping this version check until it finishes.",
        );
      }
      getActiveSteamOperations().set(normalizedInstallPath, {
        type: "version-check",
        startTime: Date.now(),
        lastOutputAt: Date.now(),
      });
    }

    try {
      return await new Promise<LatestBuildInfo | null>((resolve, reject) => {
        const args = [
          "+login",
          "anonymous",
          "+app_info_update",
          "1",
          "+app_info_print",
          "380870",
          "+quit",
        ];

        const spawnOpts: SpawnOptions = { cwd: steamcmdPath };
        if (process.platform !== "win32") {
          const ldPaths = [
            path.join(steamcmdPath, "linux32"),
            path.join(steamcmdPath, "linux64"),
            steamcmdPath,
            "/usr/lib64",
            process.env.LD_LIBRARY_PATH || "",
          ]
            .filter(Boolean)
            .join(":");
          spawnOpts.env = {
            ...buildLinuxWritableHomeEnv(steamcmdPath),
            LD_LIBRARY_PATH: ldPaths,
          };
          log.debug(
            `SteamCMD spawn: exe=${steamcmdExe}, LD_LIBRARY_PATH=${ldPaths}`,
          );
        }

        const steamcmd = spawn(steamcmdExe, args, spawnOpts);

        let output = "";
        const timeout = setTimeout(() => {
          steamcmd.kill();
          reject(new Error("SteamCMD timeout"));
        }, 60000);

        steamcmd.stdout?.on("data", (data) => {
          output += data.toString();
        });

        steamcmd.stderr?.on("data", (data) => {
          output += data.toString();
        });

        steamcmd.on("close", (code) => {
          clearTimeout(timeout);

          if (code !== 0) {
            return reject(new Error(`SteamCMD exited with code ${code}`));
          }

          const branchInfo = this.parseBranchFromOutput(output, branch);
          resolve(branchInfo);
        });

        steamcmd.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } finally {
      if (normalizedInstallPath) clearActiveSteamOperation(normalizedInstallPath);
    }
  }

  parseBranchFromOutput(output: string, targetBranch: string): LatestBuildInfo | null {
    try {
      const branch = targetBranch === "stable" ? "public" : targetBranch;

      const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
      if (!branchesMatch) {
        return null;
      }

      const branchesSection = branchesMatch[1];

      const branchRegex = new RegExp(
        `"${branch}"\\s*\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}`,
        "i",
      );
      const branchMatch = branchesSection.match(branchRegex);

      if (!branchMatch) {
        return null;
      }

      const branchContent = branchMatch[1];

      const buildIdMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const timeUpdatedMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);

      return {
        branch: targetBranch,
        buildId: buildIdMatch ? buildIdMatch[1] : null,
        timeUpdated: timeUpdatedMatch
          ? new Date(parseInt(timeUpdatedMatch[1], 10) * 1000).toISOString()
          : null,
        description: descMatch ? descMatch[1] : null,
      };
    } catch (err) {
      log.error(`Failed to parse Steam output: ${errorMessage(err)}`);
      return null;
    }
  }

  async checkForUpdates(forceEmit = false): Promise<UpdateInfo | null> {
    if (this.isChecking) {
      if (this.checkStartTime && Date.now() - this.checkStartTime > 120000) {
        log.warn(
          "UpdateChecker: Previous update check appears stuck, resetting",
        );
        this.isChecking = false;
      } else {
        log.debug("Update check already in progress, skipping");
        return this.updateAvailable;
      }
    }

    this.isChecking = true;
    this.checkStartTime = Date.now();

    try {
      const steamcmdPath = await getSetting("steamcmdPath");
      const serverPath = await getSetting("serverPath");

      if (!steamcmdPath || !serverPath) {
        log.debug("UpdateChecker: steamcmdPath or serverPath not configured");
        this.isChecking = false;
        return null;
      }

      const installed = await this.getInstalledBuildInfo(serverPath);
      if (!installed || !installed.buildId) {
        log.debug("UpdateChecker: Could not determine installed build");
        this.isChecking = false;
        return null;
      }

      this.gameVersion = await this.getGameVersion();

      const latest = await this.getLatestBuildInfo(
        steamcmdPath,
        installed.branch,
        serverPath,
      );
      if (!latest || !latest.buildId) {
        log.debug("UpdateChecker: Could not get latest build info from Steam");
        this.isChecking = false;
        return null;
      }

      this.lastCheck = new Date().toISOString();

      const installedBuild = parseInt(installed.buildId, 10);
      const latestBuild = parseInt(latest.buildId, 10);

      if (isNaN(installedBuild) || isNaN(latestBuild)) {
        log.warn("UpdateChecker: Invalid build ID format");
        this.isChecking = false;
        return null;
      }

      const updateInfo = {
        updateAvailable: latestBuild > installedBuild,
        installed: {
          buildId: installed.buildId,
          branch: installed.branch,
          lastUpdated: installed.lastUpdated,
        },
        latest: {
          buildId: latest.buildId,
          branch: latest.branch,
          timeUpdated: latest.timeUpdated,
          description: latest.description,
        },
        lastCheck: this.lastCheck,
      };

      const wasAvailable = this.updateAvailable?.updateAvailable;
      this.updateAvailable = updateInfo;

      if (updateInfo.updateAvailable) {
        log.info(
          `Server update available! Installed: ${installed.buildId}, Latest: ${latest.buildId} (${installed.branch} branch)`,
        );

        if (!wasAvailable || forceEmit) {
          this.io.emit("server:updateAvailable", updateInfo);
        }
        await this.scheduleAutoUpdate(updateInfo);
      } else {
        log.debug(
          `Server is up to date (build ${installed.buildId}, ${installed.branch} branch)`,
        );

        if (forceEmit) {
          this.io.emit("server:updateCheck", updateInfo);
        }
      }

      return updateInfo;
    } catch (err) {
      log.error(`Update check failed: ${errorMessage(err)}`);
      this.isChecking = false;
      return null;
    } finally {
      this.isChecking = false;
    }
  }

  async scheduleAutoUpdate(updateInfo: UpdateInfo): Promise<void> {
    const rconService = this.rconService;
    const serverManager = this.serverManager;
    if (this.autoUpdateRunning || this.autoUpdateTimer || !rconService || !serverManager) return;

    const enabled = await getSetting("serverAutoUpdate");
    if (enabled !== true && enabled !== "true") return;

    const warningMinutes = parseAutoUpdateWarningMinutes(
      await getSetting("serverAutoUpdateWarningMinutes"),
    );
    const activeServer = await getActiveServer();
    if (!activeServer?.installPath || activeServer.isRemote) {
      log.warn("Auto-update skipped: the active server is remote or has no local install path");
      return;
    }

    this.autoUpdateRunning = true;
    const message = warningMinutes > 0
      ? `A server update was detected. The server will restart in ${warningMinutes} minute${warningMinutes === 1 ? "" : "s"}.`
      : "A server update was detected. The server is restarting now.";
    try {
      if (rconService.connected) {
        const announced = await rconService.serverMessage(message, { skipLog: true });
        if (!announced?.success) log.warn(`Could not announce automatic update: ${announced?.error || "unknown error"}`);
      }
    } catch (error) {
      log.warn(`Could not announce automatic update: ${errorMessage(error)}`);
    }
    this.io.emit("server:autoUpdateScheduled", { warningMinutes, updateInfo });
    this.autoUpdateTimer = setTimeout(() => {
      this.autoUpdateTimer = null;
      this.runAutoUpdate(updateInfo).catch((error) => log.error(`Automatic update failed: ${errorMessage(error)}`));
    }, warningMinutes * 60 * 1000);
  }

  async runAutoUpdate(updateInfo: UpdateInfo): Promise<{ success: false; message: string } | void> {
    const serverManager = this.serverManager;
    const lifecycleLock = acquireLifecycleLock("automatic-update", serverManager?.serverName || null);
    if (!lifecycleLock) {
      this.autoUpdateRunning = false;
      log.warn("Automatic update skipped because another lifecycle operation is in progress");
      return { success: false, message: "Another server lifecycle operation is in progress" };
    }

    let shouldRestart = false;
    let normalizedInstallPath = null;
  let targetServerId: string | null = null;
    let phase: "not-started" | "before-stop" | "updating" = "not-started";
    const fail = (reason: string, message: string, params?: unknown): never => {
      const err = new AutoUpdateError(message);
      err.autoUpdateReason = reason;
      if (params) err.autoUpdateParams = params;
      throw err;
    };
    try {
      const rconService = this.rconService;
      if (!rconService || !serverManager) {
        fail("NOT_CONFIGURED", "RCON or server manager is not configured");
      }
      const configuredRconService = rconService as RconService;
      const configuredServerManager = serverManager as ServerManager;
      const enabled = await getSetting("serverAutoUpdate");
      if (enabled !== true && enabled !== "true") {
        log.info("Automatic server update cancelled because the setting was disabled");
        return;
      }
      const activeServer = await getActiveServer();
      if (!activeServer) {
        fail("NOT_CONFIGURED", "No active server is configured");
      }
      const configuredActiveServer = activeServer as NonNullable<typeof activeServer>;
      targetServerId = (activeServer?.id as string | null | undefined) ?? null;
      const steamcmdPath = await getSetting("steamcmdPath");
      const managed = await resolveManagedContainer({ serverId: activeServer?.id });
      if (managed.handled) {
        fail("MANAGED_CONTAINER", "This server runs in a panel-managed Docker container. Update the container image instead — the panel does not run SteamCMD against a managed container.");
      }
      if (!activeServer?.installPath || !steamcmdPath) fail("NOT_CONFIGURED", "SteamCMD path or server install path is not configured");

      const initialDetails = await configuredServerManager.getServerProcessDetails();
      if (initialDetails.scanFailed) fail("INITIAL_SCAN_FAILED", "Could not verify whether the server is running, so the automatic update was abandoned for safety");
      if (initialDetails.running) {
        shouldRestart = true;
        phase = "before-stop";
        if (!configuredRconService.connected) fail("RCON_NOT_CONNECTED", "RCON is not connected, so the server cannot be stopped safely");
        const saved = await configuredRconService.save({ skipLog: true });
        if (!saved?.success) fail("SAVE_FAILED", `The world could not be saved (${saved?.error || "unknown error"}), so the update was abandoned rather than lose progress`, { reason: sanitizeError(saved?.error || "unknown error") });
        const quit = await configuredRconService.quit();
        if (!quit?.success) log.warn(`Quit command failed (${quit?.error || "unknown error"}); waiting to see whether the server stops anyway`);
        const deadline = Date.now() + 5 * 60 * 1000;
        while (true) {
          const details = await configuredServerManager.getServerProcessDetails();
          if (details.scanFailed) fail("STOP_SCAN_FAILED", "Lost the ability to verify the server had stopped, so the automatic update was abandoned for safety");
          if (!details.running) break;
          if (Date.now() >= deadline) fail("STOP_TIMEOUT", "Server did not stop within 5 minutes");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      phase = "updating";
      const steamcmdExe = process.platform === "win32"
        ? path.join(steamcmdPath, "steamcmd.exe")
        : fs.existsSync(path.join(steamcmdPath, "steamcmd.sh"))
          ? path.join(steamcmdPath, "steamcmd.sh")
          : path.join(steamcmdPath, "steamcmd");
      if (!fs.existsSync(steamcmdExe)) fail("STEAMCMD_NOT_FOUND", `SteamCMD not found at ${steamcmdExe}`, { path: sanitizeError(steamcmdExe) });
      const branch = ["public", "stable"].includes(updateInfo.installed.branch) ? [] : ["-beta", updateInfo.installed.branch];
      const loginArgs = await getSteamLoginArgs();

      const candidateInstallPath = path.normalize(String(configuredActiveServer.installPath)).toLowerCase();
      if (hasActiveSteamOperation(candidateInstallPath)) {
        fail(
          "STEAM_OPERATION_IN_PROGRESS",
          "A Steam install or update is already in progress for this server's install directory, so this automatic update was abandoned rather than race it. Retry manually from Server > Update once the other Steam operation finishes.",
          { path: sanitizeError(candidateInstallPath) },
        );
      }
      getActiveSteamOperations().set(candidateInstallPath, {
        type: "auto-update",
        startTime: Date.now(),
        lastOutputAt: Date.now(),
      });
      normalizedInstallPath = candidateInstallPath;

      let code: number | null;
      let killedByWatchdog = false;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          const autoUpdateSpawnOpts: SpawnOptions = { cwd: steamcmdPath };
          if (process.platform !== "win32") {
            autoUpdateSpawnOpts.env = buildLinuxWritableHomeEnv(steamcmdPath);
          }
          const child = spawn(
            steamcmdExe,
            [
              "+force_install_dir",
              String(configuredActiveServer.installPath),
              ...loginArgs,
              "+app_update",
              "380870",
              ...branch,
              "validate",
              "+quit",
            ],
            autoUpdateSpawnOpts,
          );
          child.once("error", reject);
          child.once("close", resolve);

          const bumpLastOutput = () => {
            const operation = getActiveSteamOperations().get(candidateInstallPath);
            if (operation) operation.lastOutputAt = Date.now();
          };
          child.stdout?.on("data", bumpLastOutput);
          child.stderr?.on("data", bumpLastOutput);

          const operation = getActiveSteamOperations().get(candidateInstallPath);
          if (operation) {
            operation.watchdog = setInterval(() => {
              const activeOperation = getActiveSteamOperations().get(candidateInstallPath);
              if (!activeOperation || !isSteamOperationIdle(activeOperation)) return;
              log.error(
                `Auto-update SteamCMD produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
              );
              killedByWatchdog = true;
              child.kill();
            }, 30_000);
            operation.watchdog.unref?.();
          }
        });
      } finally {
        clearActiveSteamOperation(normalizedInstallPath);
      }
      if (killedByWatchdog) {
        const idleMinutes = STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000;
        fail(
          "STEAMCMD_STALLED",
          `SteamCMD produced no output for ${idleMinutes} minutes and was stopped`,
          { minutes: idleMinutes },
        );
      }
      if (code !== 0) fail("STEAMCMD_EXIT_CODE", `SteamCMD exited with code ${code}`, { code });

      const postUpdate = await this.getInstalledBuildInfo(
        String(configuredActiveServer.installPath),
      );
      const postBuildId = postUpdate?.buildId
        ? parseInt(postUpdate.buildId, 10)
        : NaN;
      const preBuildId = parseInt(updateInfo.installed.buildId ?? "", 10);
      if (isNaN(postBuildId) || postBuildId <= preBuildId) {
        fail(
          "BUILD_DID_NOT_ADVANCE",
          `SteamCMD exited successfully but the installed build did not change (still ${postUpdate?.buildId ?? "unreadable"}, expected newer than ${updateInfo.installed.buildId})`,
          {
            installedBuildId: sanitizeError(postUpdate?.buildId ?? "unknown"),
            previousBuildId: sanitizeError(updateInfo.installed.buildId),
          },
        );
      }

      this.io.emit("server:autoUpdateComplete", { success: true });
      await this._recordAutoUpdateResult({
        status: "success",
        at: new Date().toISOString(),
        appliedVersion: postUpdate?.buildId ?? null,
      });
    } catch (error) {
      const updateError = error instanceof AutoUpdateError ? error : new AutoUpdateError(errorMessage(error));
      this.io.emit("server:autoUpdateComplete", { success: false, error: updateError.message });
      await this._recordAutoUpdateResult({
        status: "failed",
        at: new Date().toISOString(),
        reason: updateError.autoUpdateReason || "UNKNOWN",
        params: updateError.autoUpdateParams || null,
        phase,
        serverUp: phase === "before-stop" ? true : phase === "not-started" ? null : false,
      });
      throw error;
    } finally {
      this.autoUpdateRunning = false;
      if (normalizedInstallPath) clearActiveSteamOperation(normalizedInstallPath);
      if (shouldRestart && phase !== "before-stop") {
        try {
          const started = await this.serverManager!.startServer({
            serverId: targetServerId,
          });
          if (started?.success) {
            await this._patchAutoUpdateResultServerUp(true);
          } else {
            log.error(`Automatic update could not restart the server: ${started?.error || started?.message || "unknown error"}`);
            await this._patchAutoUpdateResultServerUp(false);
          }
        } catch (error) {
          log.error(`Automatic update could not restart the server: ${errorMessage(error)}`);
          await this._patchAutoUpdateResultServerUp(false);
        }
      }
      lifecycleLock.release();
    }
  }

  async _recordAutoUpdateResult(result: AutoUpdateResultInput): Promise<void> {
    this.lastAutoUpdateResult = { ...result, dismissed: false };
    await setSetting("lastAutoUpdateResult", this.lastAutoUpdateResult);
  }

  async _patchAutoUpdateResultServerUp(serverUp: boolean): Promise<void> {
    if (!this.lastAutoUpdateResult || this.lastAutoUpdateResult.status !== "failed") return;
    this.lastAutoUpdateResult = { ...this.lastAutoUpdateResult, serverUp };
    await setSetting("lastAutoUpdateResult", this.lastAutoUpdateResult);
  }

  async dismissAutoUpdateResult(): Promise<void> {
    if (this.lastAutoUpdateResult === undefined) {
      this.lastAutoUpdateResult = (await getSetting("lastAutoUpdateResult")) || null;
    }
    if (!this.lastAutoUpdateResult) return;
    this.lastAutoUpdateResult = { ...this.lastAutoUpdateResult, dismissed: true };
    await setSetting("lastAutoUpdateResult", this.lastAutoUpdateResult);
  }

  async getStatus(): Promise<{
    updateAvailable: UpdateInfo | null;
    gameVersion: string | null;
    lastCheck: string | null;
    intervalMinutes: number;
    isChecking: boolean;
    lastAutoUpdateResult: AutoUpdateResult | null;
  }> {
    if (this.lastAutoUpdateResult === undefined) {
      this.lastAutoUpdateResult = (await getSetting("lastAutoUpdateResult")) || null;
    }
    return {
      updateAvailable: this.updateAvailable,
      gameVersion: this.gameVersion,
      lastCheck: this.lastCheck,
      intervalMinutes: this.intervalMs / 60000,
      isChecking: this.isChecking,
      lastAutoUpdateResult: this.lastAutoUpdateResult ?? null,
    };
  }
}

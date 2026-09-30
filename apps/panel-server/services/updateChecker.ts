import { spawn, type SpawnOptions } from "child_process";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("Updates");
import { getSetting, setSetting, getCurrentServer, getServers, updateServer } from "../database/init.ts";
import { isBundledGameProfile } from "./managedContainer.ts";
import { getServerRuntimes } from "../utils/panelRuntime.ts";
import { runForServer } from "../utils/serverScope.ts";
import { isLifecycleLocked } from "./lifecycleCoordinator.ts";
import { type ServerMaintenance, type MaintenanceResult } from "./serverMaintenance.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import {
  hasActiveSteamOperation,
  steamInstallKey,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  isSteamOperationIdle,
  STEAM_OPERATION_IDLE_TIMEOUT_MS,
} from "./activeSteamOperations.ts";
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
  getPlayers?: () => Promise<{ success?: boolean; players?: unknown[] }>;
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
  maintenance?: ServerMaintenance;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  maintenance?: ServerMaintenance;
  updating = false;
  lastUpdateResult: (MaintenanceResult & { at: string }) | null = null;
  intervalMs: number;
  checkStartTime: number | null;

  constructor(io: UpdateSocket, { rconService, serverManager, maintenance }: UpdateCheckerOptions = {}) {
    this.io = io;
    this.rconService = rconService;
    this.serverManager = serverManager;
    this.checkInterval = null;
    this.lastCheck = null;
    this.updateAvailable = null;
    this.gameVersion = null;
    this.isChecking = false;
    this.maintenance = maintenance;

    this.intervalMs = 30 * 60 * 1000;
    this.initialTimeout = null;
    this.checkStartTime = null;
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
      const activeServer = await getCurrentServer();
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
      normalizedInstallPath = steamInstallKey(installPath);
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

  async beginUpdate(options: { installPath?: string; steamcmdPath?: string; branch?: string; validateFiles?: boolean; warningMinutes?: number } = {}): Promise<{ success: boolean; message: string }> {
    if (isLifecycleLocked()) throw new Error("Another lifecycle operation is already in progress for this server.");
    if (this.updating || this.maintenance?.active) throw new Error("Maintenance is already pending for this server.");
    if (!this.maintenance) throw new Error("The server maintenance service is unavailable.");
    const server = await getCurrentServer();
    if (!server?.installPath || !server.serverName) throw new Error("A configured game installation is required.");
    if (options.installPath && steamInstallKey(options.installPath) !== steamInstallKey(server.installPath)) throw new Error("Update target does not match the server in the URL.");
    if (server.dockerContainerName && !isBundledGameProfile(server)) throw new Error("Update this external container through its owner.");
    const steamcmdPath = options.steamcmdPath || await getSetting("steamcmdPath") || (isBundledGameProfile(server) ? "/home/steam/steamcmd" : null);
    if (!steamcmdPath) throw new Error("Configure the SteamCMD path first.");
    const exe = process.platform === "win32" ? path.join(steamcmdPath, "steamcmd.exe") : ["steamcmd.sh", "steamcmd"].map(name => path.join(steamcmdPath, name)).find(file => fs.existsSync(file));
    if (!exe || !fs.existsSync(exe)) throw new Error("SteamCMD executable was not found.");
    const installed = await this.getInstalledBuildInfo(server.installPath);
    if (!installed?.buildId) throw new Error("The installed Steam build could not be verified.");
    const branch = options.branch || installed.branch;
    if (!/^(?:stable|public|unstable|42(?:\.\d+){1,2})$/.test(branch)) throw new Error("Choose a supported Build 42 Steam branch.");
    const warningMinutes = options.warningMinutes ?? 15;
    if (!Number.isInteger(warningMinutes) || warningMinutes < 0 || warningMinutes > 60 || typeof options.validateFiles !== "undefined" && typeof options.validateFiles !== "boolean") throw new Error("Invalid update options.");
    const expectedBuild = this.updateAvailable?.latest.branch === branch ? this.updateAvailable.latest.buildId : null;
    const key = steamInstallKey(server.installPath);
    if (hasActiveSteamOperation(key)) throw new Error("A Steam operation is already in progress for this install.");
    // Reserve before the first asynchronous peer check; every native/container start checks the same reservation.
    getActiveSteamOperations().set(key, { type: "update", startTime: Date.now(), lastOutputAt: Date.now(), branch });
    this.updating = true;
    const peersStopped = async () => {
      for (const peer of await getServers()) {
        if (peer.id === server.id || !peer.installPath || steamInstallKey(peer.installPath) !== key) continue;
        const runtime = getServerRuntimes().find(runtime => String(runtime.serverId) === String(peer.id));
        if (!runtime?.maintenance || (await runForServer(peer.id, () => runtime.maintenance.state())).running) throw new Error(`Stop ${peer.name || peer.serverName} before updating its shared game install.`);
      }
    };
    try { await peersStopped(); await this.maintenance.state(); }
    catch (error) { clearActiveSteamOperation(key); this.updating = false; throw error; }
    this.io.emit("steam:start", { type: options.validateFiles ? "verify" : "update", message: "Saving and stopping the server before SteamCMD..." });
    void this.maintenance.run({ kind: "pz-update", label: options.validateFiles ? "Verify game files" : "Game update", warningMinutes,
      work: async signal => {
        try {
          await peersStopped(); signal.throwIfAborted();
          const beta = ["public", "stable"].includes(branch) ? [] : ["-beta", branch];
          const login = await getSteamLoginArgs();
          await this.runSteamCmd(exe, steamcmdPath, ["+force_install_dir", server.installPath!, ...login, "+app_update", "380870", ...beta, "validate", "+quit"], key, signal);
          const updated = await this.getInstalledBuildInfo(server.installPath!);
          if (!updated?.buildId || ![branch, branch === "stable" ? "public" : branch].includes(updated.branch)) throw new Error("SteamCMD did not install the selected branch; the game was left stopped.");
          if (!options.validateFiles && branch === installed.branch && BigInt(updated.buildId) < BigInt(installed.buildId!)) throw new Error("SteamCMD installed an older build; the game was left stopped.");
          if (!options.validateFiles && expectedBuild && BigInt(updated.buildId) < BigInt(expectedBuild)) throw new Error(`SteamCMD did not install the expected build ${expectedBuild}; the game was left stopped.`);
          await updateServer(server.id, { branch });
          this.updateAvailable = null;
          return { success: true, message: `Game ${options.validateFiles ? "verification" : "update"} completed (build ${updated.buildId}).` };
        } finally { clearActiveSteamOperation(key); }
      },
    }).then(async result => {
      this.lastUpdateResult = { ...result, at: new Date().toISOString() };
      try { await setSetting("lastGameUpdateResult", this.lastUpdateResult); }
      catch (error) { log.error(`Update completed; result could not be recorded: ${errorMessage(error)}`); }
      this.io.emit("steam:complete", result); this.io.emit("server:updateComplete", this.lastUpdateResult);
    }).catch(error => { log.error(`Update result could not be recorded: ${errorMessage(error)}`); this.io.emit("steam:complete", { success: false, message: sanitizeError(errorMessage(error)) }); })
      .finally(() => { clearActiveSteamOperation(key); this.updating = false; });
    return { success: true, message: "Game maintenance started." };
  }

  private async runSteamCmd(exe: string, cwd: string, args: string[], key: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, args, { cwd, detached: process.platform !== "win32", env: process.platform === "win32" ? process.env : buildLinuxWritableHomeEnv(cwd) });
      let output = "", failure: Error | null = null;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        if (process.platform === "win32") {
          if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill("SIGKILL"));
        } else if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const abort = () => stop(new Error("Game update cancelled; the game was left stopped."));
      signal.addEventListener("abort", abort, { once: true });
      const timer = setInterval(() => {
        if (isSteamOperationIdle(getActiveSteamOperations().get(key))) stop(new Error(`SteamCMD produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes.`));
      }, 30000); timer.unref?.();
      const operation = getActiveSteamOperations().get(key)!; operation.pid = child.pid; operation.watchdog = timer;
      const read = (data: Buffer, stream: string) => {
        operation.lastOutputAt = Date.now(); const line = data.toString(); output = (output + line).slice(-65536);
        this.io.emit("steam:log", { text: line.slice(-4096), stream, message: line.slice(-4096) });
      };
      child.stdout?.on("data", data => read(data, "stdout")); child.stderr?.on("data", data => read(data, "stderr"));
      const clean = () => { clearInterval(timer); signal.removeEventListener("abort", abort); operation.pid = undefined; };
      child.once("error", error => { clean(); reject(error); });
      child.once("close", code => {
        clean(); if (failure) reject(failure);
        else if (code !== 0 || !/Success! App ['"]?380870['"]? fully installed/i.test(output)) reject(new Error(`SteamCMD did not confirm a complete install (exit ${code}). The game was left stopped.`));
        else resolve();
      });
      if (signal.aborted) abort();
    });
  }

  async getStatus() {
    return { updateAvailable: this.updateAvailable, gameVersion: this.gameVersion, lastCheck: this.lastCheck,
      intervalMinutes: this.intervalMs / 60000, isChecking: this.isChecking, updating: this.updating,
      lastUpdateResult: this.lastUpdateResult || await getSetting("lastGameUpdateResult") || null,
    };
  }
}

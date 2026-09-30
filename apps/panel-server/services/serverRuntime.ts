import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { RconService } from "./rcon.ts";
import { ServerManager } from "./serverManager.ts";
import { ModChecker, refreshWorkshopChecker } from "./modChecker.ts";
import { LogTailer } from "./logTailer.ts";
import { ServerMaintenance } from "./serverMaintenance.ts";
import { Scheduler } from "./scheduler.ts";
import { BackupService } from "./backupService.ts";
import { UpdateChecker } from "./updateChecker.ts";
import { GameIntegration } from "./gameIntegration.ts";
import { DiskMonitor } from "./diskMonitor.ts";
import { ensureGameIntegrationInstalled } from "./gameIntegrationInstaller.ts";
import {
  getCurrentServer,
  getSetting,
  recordPerformanceSnapshot,
  syncPlayerSessions,
} from "../database/init.ts";
import { getServerName } from "./sandboxPersistence.ts";
import { getDataPaths } from "../utils/paths.ts";
import { getDiskFree } from "../utils/diskSpace.ts";
import { getSwapInfo } from "../utils/swapInfo.ts";
import { createLogger, logSection } from "../utils/logger.ts";
import { acquireLifecycleLock } from "./lifecycleCoordinator.ts";
import {
  setServerRuntime,
  removeServerRuntime,
} from "../utils/panelRuntime.ts";
import { runForServer } from "../utils/serverScope.ts";
import {
  observeServerStatus,
  classifyStartupProcessState,
  probeRconFallbackIfConfigured,
} from "./serverDetection.ts";
import type { Server } from "socket.io";
import type { DockerClient } from "./dockerClient.ts";

type AnyRecord = Record<string, any>;
type PlayerRecord = AnyRecord & { name: string };
type SwapSnapshot = { total: number; used: number };

async function initializeServerRuntime(
  serverId: string | number,
  sockets: Server,
  dockerClient: DockerClient,
) {
  return runForServer(serverId, async () => {
    const log = createLogger(`Server:${serverId}`);
    let stopped = false;
    const room = `server:${serverId}`;
    const io = {
      emit: (event: string, ...args: any[]) =>
        sockets.to(room).emit(event, ...args),
      to: (channel: string) => sockets.to(`${room}:${channel}`),
    };
    const rconService = new RconService();
    const serverManager = new ServerManager();
    const modChecker = new ModChecker();
    const logTailer = new LogTailer();
    const maintenance = new ServerMaintenance(String(serverId), rconService, serverManager, io);
    const scheduler = new Scheduler(rconService, serverManager, maintenance);
    const backupService = new BackupService(maintenance);
    const gameIntegration = new GameIntegration();
    const diskMonitor = new DiskMonitor(io);
    rconService.setServerManager(serverManager);
    scheduler.setBackupService(backupService);
    scheduler.setIo(io);

    rconService.on("connected", () => {
      rconConnectedAt = Date.now();
      lastPlayerList = [];
    });

    rconService.on("disconnected", () => {
      setTimeout(() => {
        checkServerStatusNow("RCON disconnect");
      }, 3000);
    });

    gameIntegration.on("status", (status) => {
      io.emit("gameIntegration:status", status);
    });

    gameIntegration.on("snapshot", (snapshot) => {
      io.emit("gameIntegration:modStatus", snapshot);
    });

    backupService.setServerManager(serverManager);
    backupService.setRconService(rconService);

    const updateChecker = new UpdateChecker(io, { rconService, serverManager, maintenance });

    let lastPlayerList: PlayerRecord[] = [];
    let playerPollingInterval: ReturnType<typeof setInterval> | null = null;
    let rconConnectedAt = 0;

    function startPlayerPolling() {
      if (playerPollingInterval) {
        clearInterval(playerPollingInterval);
      }
      lastPlayerList = [];

      playerPollingInterval = setInterval(async () => {
        try {
          if (!rconService.connected) {
            return;
          }

          if (rconConnectedAt && Date.now() - rconConnectedAt < 15000) {
            return;
          }

          const result = (await rconService.getPlayers()) as {
            success?: boolean;
            players?: PlayerRecord[];
          };
          if (result.success && result.players) {
            await syncPlayerSessions(
              result.players.map((player) => player.name).filter(Boolean),
            );
            const currentNames = result.players
              .map((p) => p.name)
              .sort()
              .join(",");
            const lastNames = lastPlayerList
              .map((p) => p.name)
              .sort()
              .join(",");

            if (currentNames !== lastNames) {
              lastPlayerList = result.players;
              io.to("players").emit("players:update", result.players);
              log.debug(
                `Player list updated: ${result.players.length} players online`,
              );
            }
          }
        } catch (error: any) {
          log.debug(`Player polling error: ${error.message}`);
        }
      }, 5000);
      if (playerPollingInterval.unref) playerPollingInterval.unref();

      log.info("Server-side player polling started (5s interval)");
    }

    function stopPlayerPolling() {
      if (playerPollingInterval) {
        clearInterval(playerPollingInterval);
        playerPollingInterval = null;
        log.info("Server-side player polling stopped");
      }
    }

    let perfPollingInterval: ReturnType<typeof setInterval> | null = null;
    let lastCpuInfo: { total: number; idle: number } | null = null;

    function getCpuUsage() {
      const cpus = os.cpus();
      const total = cpus.reduce(
        (acc, cpu) => {
          const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
          const idle = cpu.times.idle;
          return { total: acc.total + t, idle: acc.idle + idle };
        },
        { total: 0, idle: 0 },
      );

      if (!lastCpuInfo) {
        lastCpuInfo = total;
        return 0;
      }

      const totalDiff = total.total - lastCpuInfo.total;
      const idleDiff = total.idle - lastCpuInfo.idle;
      lastCpuInfo = total;
      return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
    }

    let lastDiskSample: { at: number; value: SwapSnapshot | null } = {
      at: 0,
      value: null,
    };
    const DISK_SAMPLE_INTERVAL_MS = 60000;

    async function getDiskSnapshot() {
      const now = Date.now();
      if (now - lastDiskSample.at < DISK_SAMPLE_INTERVAL_MS) {
        return lastDiskSample.value;
      }
      lastDiskSample.at = now;
      try {
        const activeServer = await getCurrentServer();
        const target =
          activeServer?.zomboidDataPath ||
          activeServer?.installPath ||
          getDataPaths().dataDir;
        const disk = await getDiskFree(target);
        lastDiskSample.value =
          disk && disk.total > 0
            ? { total: disk.total, used: disk.total - disk.free }
            : null;
      } catch {
        lastDiskSample.value = null;
      }
      return lastDiskSample.value;
    }

    let lastSwapSample: { at: number; value: SwapSnapshot | null } = {
      at: 0,
      value: null,
    };
    const SWAP_SAMPLE_INTERVAL_MS = 60000;

    async function getSwapSnapshot() {
      const now = Date.now();
      if (now - lastSwapSample.at < SWAP_SAMPLE_INTERVAL_MS) {
        return lastSwapSample.value;
      }
      lastSwapSample.at = now;
      try {
        lastSwapSample.value = await getSwapInfo();
      } catch {
        lastSwapSample.value = null;
      }
      return lastSwapSample.value;
    }

    async function getPzProcessMemory(): Promise<number | null> {
      const server = await getCurrentServer();
      const containerId =
        server?.dockerContainerId || server?.dockerContainerName;
      if (containerId)
        return (
          (await dockerClient.getContainerStats(containerId))?.memoryUsed ??
          null
        );
      const details = await serverManager.getServerProcessDetails();
      if (details.scanFailed || !details.running) return null;
      const pid = Number(details.owned?.[0]?.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      return new Promise((resolve) => {
        const windows = process.platform === "win32";
        execFile(
          windows ? "powershell.exe" : "ps",
          windows
            ? [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
              ]
            : ["-p", String(pid), "-o", "rss="],
          { timeout: 5000 },
          (error, stdout) => {
            const memory = Number(stdout.trim());
            resolve(
              !error && Number.isFinite(memory) && memory >= 0
                ? memory * (windows ? 1 : 1024)
                : null,
            );
          },
        );
      });
    }

    async function startPerfPolling() {
      if (perfPollingInterval) clearInterval(perfPollingInterval);

      getCpuUsage();

      perfPollingInterval = setInterval(async () => {
        try {
          const hostMem = os.totalmem();
          const hostMemFree = os.freemem();
          const cpuUsage = getCpuUsage();
          const panelMem = process.memoryUsage();

          const pzMemBytes = await getPzProcessMemory();
          const disk = await getDiskSnapshot();
          const swap = await getSwapSnapshot();

          const snapshot = {
            hostMemTotal: hostMem,
            hostMemUsed: hostMem - hostMemFree,
            cpuUsage,
            hostDiskTotal: disk?.total ?? null,
            hostDiskUsed: disk?.used ?? null,
            hostSwapTotal: swap?.total ?? null,
            hostSwapUsed: swap?.used ?? null,
            panelMemHeap: panelMem.heapUsed,
            panelMemRss: panelMem.rss,
            pzMemUsed: pzMemBytes,
            memoryUsed: panelMem.heapUsed,
            memoryTotal: panelMem.heapTotal,
            playerCount: lastPlayerList.length,
            serverRunning: serverManager.isRunning,
          };

          await recordPerformanceSnapshot(snapshot);

          io.to("perf").emit("perf:snapshot", snapshot);
        } catch (err: any) {
          log.debug(`Perf snapshot failed: ${err.message}`);
        }
      }, 60000);

      if (perfPollingInterval.unref) perfPollingInterval.unref();
      log.info("Performance polling started (60s interval)");
    }

    function stopPerfPolling() {
      if (perfPollingInterval) {
        clearInterval(perfPollingInterval);
        perfPollingInterval = null;
      }
    }

    let statusWatchdogInterval: ReturnType<typeof setInterval> | null = null;
    let lastKnownRunning: boolean | null = null;

    async function checkServerStatusNow(
      detectionReason = "watchdog",
    ): Promise<void> {
      if (stopped) return;
      try {
        const previous = lastKnownRunning;
        lastKnownRunning = await observeServerStatus(
          { serverManager, rconService, dockerClient, io },
          lastKnownRunning,
          detectionReason,
        );
        if (previous !== false && lastKnownRunning === false) {
          await syncPlayerSessions([]);
        }
      } catch (error: any) {
        log.debug(`Status watchdog error: ${error.message}`);
      }
    }

    function startStatusWatchdog() {
      if (statusWatchdogInterval) clearInterval(statusWatchdogInterval);
      statusWatchdogInterval = setInterval(checkServerStatusNow, 10000);
      if (statusWatchdogInterval.unref) statusWatchdogInterval.unref();
      log.info("Server status watchdog started (10s interval)");
    }

    const services = {
      serverId: String(serverId),
      rconService,
      serverManager,
      modChecker,
      logTailer,
      scheduler,
      maintenance,
      backupService,
      gameIntegration,
      updateChecker,
      diskMonitor,
      refreshWorkshopChecker,
      io,
      checkServerStatusNow,
      stop: async () =>
        runForServer(serverId, async () => {
          stopped = true;
          stopPlayerPolling();
          stopPerfPolling();
          if (statusWatchdogInterval) clearInterval(statusWatchdogInterval);
          scheduler.stopAllJobs();
          modChecker.stop();
          logTailer.stopWatching();
          updateChecker.stop();
          await maintenance.shutdown();
          diskMonitor.stop();
          gameIntegration.stop();
          rconService.stopAutoReconnect();
          await rconService.disconnect();
          initializations.delete(String(serverId));
          removeServerRuntime(serverId);
        }),
    };
    setServerRuntime(serverId, services);
    try {
      await serverManager.loadConfig(String(serverId));
      await rconService.loadConfig(String(serverId));
      rconService.startAutoReconnect();
      const activeServer = await getCurrentServer();
      if (activeServer?.zomboidDataPath && activeServer.serverName) {
        try {
          const serverName = await getServerName(activeServer);
          const directory = path.join(
            activeServer.zomboidDataPath,
            "Lua",
            "argus",
            serverName,
          );
          gameIntegration.start(directory, serverName);
        } catch (error: any) {
          log.warn(`Game integration could not start: ${error.message}`);
        }
      }
      await logTailer.init();

      logTailer.on("playerDeath", async (data) => {
        try {
          const { logPlayerAction } = await import("../database/init.ts");
          logPlayerAction(
            data.player,
            "death",
            `${data.pvp ? "PvP" : "non-pvp"} death at (${data.location})`,
          ).catch((err) =>
            log.debug(`Failed to log player death: ${err.message}`),
          );
        } catch (err: any) {
          log.debug(`playerDeath DB log failed: ${err.message}`);
        }
        io.emit("player:death", data);
      });

      await scheduler.init();

      await modChecker.init(scheduler, serverManager, io);

      if (modChecker.workshopAcfPath) {
        modChecker.start();
      } else {
        log.info(
          "Mod checker: Workshop ACF not found — configure server install path",
        );
      }

      logSection("Server Detection");

      (async () => {
        try {
          await new Promise((r) => setTimeout(r, 1000));
          if (stopped) return;

          const timeoutMs = 15000;
          const activeServer = await getCurrentServer();
          const processState = (await Promise.race([
            serverManager.getServerProcessDetails(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Server check timeout")),
                timeoutMs,
              ),
            ),
          ])) as AnyRecord | null;
          const startupState = classifyStartupProcessState(processState);
          const processStateUnknown = startupState.unknown;
          const isRunning = startupState.running;

          if (isRunning || processStateUnknown) {
            log.info(
              processStateUnknown
                ? "PZ server process state is unknown - trying RCON but will not auto-start"
                : "PZ server detected running - connecting RCON...",
            );

            let connected = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              if (stopped) return;
              try {
                await Promise.race([
                  rconService.connect(),
                  new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error("RCON connection timeout")),
                      timeoutMs,
                    ),
                  ),
                ]);

                if (rconService.connected) {
                  connected = true;
                  log.info(`RCON connected on attempt ${attempt}`);
                  break;
                }
              } catch (e: any) {
                log.debug(
                  `RCON connection attempt ${attempt} failed: ${e.message}`,
                );
                if (attempt < 3) {
                  await new Promise((r) => setTimeout(r, 5000));
                }
              }
            }

            if (!connected) {
              log.warn(
                "RCON connection failed after 3 attempts - auto-reconnect will keep trying",
              );
            }
          } else {
            log.info("PZ server not detected running on startup");

            const rconPortOccupied = await probeRconFallbackIfConfigured(
              activeServer,
              rconService,
              timeoutMs,
            );

            if (stopped) return;
            const autoStartServer = await getSetting("autoStartServer");
            if (autoStartServer === true || autoStartServer === "true") {
              if (rconPortOccupied) {
                log.warn(
                  "Auto-start SKIPPED: RCON port is already occupied — a PZ server is likely running but process detection failed. Will keep retrying RCON connection.",
                );
                rconService.setServerStarting(false);
              } else {
                const lifecycleLock = acquireLifecycleLock(
                  "startup-auto-start",
                  activeServer?.name || activeServer?.serverName || null,
                );
                if (!lifecycleLock) {
                  log.warn(
                    "Auto-start skipped because another lifecycle operation is in progress",
                  );
                  rconService.setServerStarting(false);
                } else {
                  log.info("Auto-start is enabled - starting PZ server...");

                  rconService.setServerStarting(true);

                  try {
                    await ensureGameIntegrationInstalled(activeServer);
                    const startResult = await serverManager.startServer({
                      serverId:
                        (activeServer?.id as string | null | undefined) ?? null,
                    });
                    if (startResult.success) {
                      log.info("PZ server auto-started successfully");

                      log.info(
                        "PZ server auto-started - Monitoring RCON port...",
                      );

                      await rconService.loadConfig();
                      const rconHost = rconService.config.host || "127.0.0.1";
                      const rconPort = rconService.config.port || 27015;

                      const maxPollAttempts = 60;

                      for (let i = 0; i < maxPollAttempts; i++) {
                        if (stopped) return;
                        const portOpen = await rconService.checkPortOpen(
                          rconHost,
                          rconPort,
                        );

                        if (!portOpen) {
                          if (i % 6 === 0) {
                            log.debug(
                              `Auto-start: Waiting for RCON port ${rconHost}:${rconPort}...`,
                            );
                          }
                          await new Promise((r) => setTimeout(r, 5000));
                          continue;
                        }

                        log.info(`RCON port open! Attempting connection...`);

                        try {
                          await Promise.race([
                            rconService.connect(),
                            new Promise((_, reject) =>
                              setTimeout(
                                () =>
                                  reject(new Error("RCON connection timeout")),
                                15000,
                              ),
                            ),
                          ]);

                          if (rconService.connected) {
                            log.info(
                              "RCON connected successfully after auto-start",
                            );
                            break;
                          } else {
                            log.debug(
                              "RCON port open but connection failed, retrying in 5s...",
                            );
                            await new Promise((r) => setTimeout(r, 5000));
                          }
                        } catch (e: any) {
                          log.debug(
                            `Auto-start RCON connection failed: ${e.message}`,
                          );
                          await new Promise((r) => setTimeout(r, 5000));
                        }
                      }
                    } else {
                      log.error(
                        "Failed to auto-start PZ server:",
                        startResult.error,
                      );
                    }
                  } catch (e: any) {
                    log.error("Error during auto-start:", e.message);
                  } finally {
                    rconService.setServerStarting(false);
                    lifecycleLock.release();
                  }
                }
              }
            }

            // Keep the integration monitor attached to this profile; its heartbeat will expire while stopped.
          }
        } catch (e: any) {
          log.debug(`Startup initialization: ${e.message}`);
        }
      })();

      startPlayerPolling();

      startPerfPolling();

      startStatusWatchdog();

      updateChecker.start();

      diskMonitor.start();
      return services;
    } catch (error) {
      await services.stop();
      throw error;
    }
  });
}

const initializations = new Map<
  string,
  Promise<Awaited<ReturnType<typeof initializeServerRuntime>>>
>();
export function startServerRuntime(
  id: string | number,
  sockets: Server,
  dockerClient: DockerClient,
) {
  const key = String(id);
  let pending = initializations.get(key);
  if (!pending) {
    pending = initializeServerRuntime(key, sockets, dockerClient).catch(
      (error) => {
        initializations.delete(key);
        removeServerRuntime(key);
        throw error;
      },
    );
    initializations.set(key, pending);
  }
  return pending;
}

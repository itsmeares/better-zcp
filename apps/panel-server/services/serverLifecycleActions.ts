import { createLogger } from "../utils/logger.ts";
import { getActiveServer, logServerEvent } from "../database/init.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { runManagedLifecycle } from "./managedContainer.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "./lifecycleCoordinator.ts";
import { autoInstallBridgeIfNeeded } from "./panelBridgeInstaller.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
import {
  attemptBoundedSaveBeforeForceStop,
  isFirstBootMissingAdminPassword,
  monitorGracefulStop,
  refreshLaunchTargetBeforeStart,
  waitForRconAfterStart,
} from "./serverLaunch.ts";

const log = createLogger("ServerLifecycle");

export type ServerLifecycleRuntime = Record<string, any>;

type LifecycleError = Error & {
  status?: number;
  code?: string;
  params?: unknown;
};

function lifecycleError(
  message: unknown,
  status: number,
  code?: string,
  params?: unknown,
): LifecycleError {
  return Object.assign(new Error(sanitizeError(message)), {
    status,
    ...(code ? { code } : {}),
    ...(params !== undefined ? { params } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function logServerEventBestEffort(
  eventType: string,
  message?: string,
): Promise<void> {
  try {
    await logServerEvent(eventType, message);
  } catch (error) {
    log.warn(`Could not record server event: ${errorMessage(error)}`);
  }
}

function emitRestartResult(
  io: ServerLifecycleRuntime["io"],
  result: any,
): void {
  if (typeof io?.emit !== "function") return;
  io.emit("scheduler:action_result", {
    kind: "restart",
    success: !!result?.success,
    message:
      result?.message ||
      (result?.success ? "Restart completed" : "Restart failed"),
  });
}

function setServerStarting(rconService: any, starting: boolean): void {
  if (rconService.setServerStarting) {
    rconService.setServerStarting(starting);
  } else {
    rconService.serverStarting = starting;
  }
}

export async function startServerAction(
  runtime: ServerLifecycleRuntime,
  _data: Record<string, any> = {},
) {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "start",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    const response = lifecycleInProgressResponse();
    throw lifecycleError(response.error, 409, response.code);
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
      `Server start requested (server=${activeServer?.name || "unknown"}, remote=${activeServer?.isRemote || false})`,
    );
    if (activeServer?.isRemote) {
      throw lifecycleError(
        "Cannot start a remote server. Remote servers are managed externally — use RCON to interact.",
        400,
        ErrorCode.SERVER_START_REMOTE_REFUSED,
      );
    }
    if (!activeServer) {
      throw lifecycleError("No active server configured", 404);
    }

    autoInstallBridgeIfNeeded(activeServer);

    const managed = await runManagedLifecycle("start", {
      serverId: activeServer.id ?? null,
    });
    if (managed.handled && !managed.success) {
      throw lifecycleError(sanitizeError(managed.error), 502);
    }
    if (managed.alreadyRunning) return managed;

    if (!managed.handled && isFirstBootMissingAdminPassword(activeServer)) {
      throw lifecycleError(
        `${activeServer.name || activeServer.serverName} has never started before and has no admin password set. ` +
          `Project Zomboid needs one to create the admin account on first boot, or the server process hangs waiting ` +
          `for console input that will never come and crashes. Set an admin password for this server (My Servers → ` +
          `${activeServer.name || activeServer.serverName} → Admin Password), then try starting again.`,
        400,
      );
    }

    const { scriptBackupWarnings } = await refreshLaunchTargetBeforeStart(
      activeServer,
      { managedHandled: Boolean(managed.handled) },
    );
    const result = managed.handled
      ? { success: true, message: managed.message || "Container starting" }
      : await runtime.serverManager.startServer({
          serverId: activeServer.id ?? null,
        });
    if (scriptBackupWarnings.length > 0) {
      result.scriptWarnings = scriptBackupWarnings;
    }

    setServerStarting(runtime.rconService, true);
    runtime.io?.emit?.("server:status", { state: "starting" });

    if (managed.handled) {
      log.info(
        "Container start confirmed by Docker; skipping local process poll",
      );
      lifecycleLockTransferred = true;
      void waitForRconAfterStart({
        rconService: runtime.rconService,
        discordBot: runtime.discordBot,
        io: runtime.io,
      })
        .catch((error) =>
          log.error(`Post-start RCON wait failed: ${errorMessage(error)}`),
        )
        .finally(() => releaseLifecycleLock());
      return result;
    }

    let attempts = 0;
    const maxAttempts = 30;
    let pollCleared = false;
    const pollInterval = setInterval(async () => {
      if (pollCleared) return;
      try {
        attempts++;
        const processDetails =
          typeof runtime.serverManager.getServerProcessDetails === "function"
            ? await runtime.serverManager.getServerProcessDetails()
            : { running: false, scanFailed: true };

        if (!processDetails || processDetails.scanFailed) {
          if (attempts >= maxAttempts) {
            pollCleared = true;
            clearInterval(pollInterval);
            releaseLifecycleLock();
            setServerStarting(runtime.rconService, false);
            runtime.io?.emit?.("server:status", { state: "unknown" });
            log.warn(
              "Server start polling timed out without confirming process state",
            );
          }
          return;
        }

        if (processDetails.running) {
          pollCleared = true;
          clearInterval(pollInterval);
          log.info("Server detected as running");
          await waitForRconAfterStart({
            rconService: runtime.rconService,
            discordBot: runtime.discordBot,
            io: runtime.io,
          });
          releaseLifecycleLock();
        } else if (attempts >= maxAttempts) {
          pollCleared = true;
          clearInterval(pollInterval);
          releaseLifecycleLock();
          setServerStarting(runtime.rconService, false);
          runtime.io?.emit?.("server:status", {
            state: "stopped",
            running: false,
          });
          log.warn("Server start polling timed out");
        }
      } catch (error) {
        pollCleared = true;
        clearInterval(pollInterval);
        releaseLifecycleLock();
        setServerStarting(runtime.rconService, false);
        runtime.io?.emit?.("server:status", { state: "unknown" });
        log.error(`Server status poll failed: ${errorMessage(error)}`);
      }
    }, 1000);
    lifecycleLockTransferred = true;
    return result;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw lifecycleError(errorMessage(error), 500);
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
}

export async function stopServerAction(
  runtime: ServerLifecycleRuntime,
  _data: Record<string, any> = {},
) {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "stop",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    const response = lifecycleInProgressResponse();
    throw lifecycleError(response.error, 409, response.code);
  }

  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
  };

  try {
    log.info("Graceful shutdown requested");
    if (!runtime.rconService.connected) {
      throw lifecycleError(
        "RCON not connected. Cannot gracefully stop server.",
        400,
        ErrorCode.SERVER_STOP_RCON_NOT_CONNECTED,
      );
    }

    const saved = await runtime.rconService.save({
      retryOnConnectionError: false,
    });
    if (!saved?.success) {
      throw lifecycleError(
        `Save failed, so the server was left running: ${sanitizeError(saved?.error)}`,
        502,
        ErrorCode.SERVER_STOP_SAVE_FAILED,
      );
    }

    runtime.io?.emit?.("server:status", { state: "stopping" });
    const managed = await runManagedLifecycle("stop", {
      serverId: activeServerForLock?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      throw lifecycleError(
        `The world was saved, but the container could not be stopped: ${sanitizeError(managed.error)}`,
        502,
        ErrorCode.SERVER_STOP_CONTAINER_STOP_FAILED,
      );
    }

    if (!managed.handled && runtime.serverManager.loadConfig) {
      await runtime.serverManager.loadConfig(activeServerForLock?.id ?? null);
    }
    const serviceManaged = Boolean(
      !managed.handled && runtime.serverManager.usesManagedServiceLifecycle?.(),
    );
    const result = managed.handled
      ? { success: true, message: managed.message || "Container stopping" }
      : serviceManaged
        ? await runtime.serverManager.stopServer(false, {
            serverId: activeServerForLock?.id ?? null,
          })
        : await runtime.rconService.quit({ retryOnConnectionError: false });

    if (!result?.success || result.confirmed === false) {
      const failure = {
        ...result,
        success: false,
        error: result?.error || result?.message || "Server stop failed",
      };
      throw lifecycleError(failure.error, 502, undefined, failure);
    }

    if (managed.handled || serviceManaged) {
      runtime.serverManager?.markServerStopped?.();
      runtime.io?.emit?.("server:status", { running: false, state: "stopped" });
      if (typeof runtime.checkServerStatusNow === "function") {
        Promise.resolve(runtime.checkServerStatusNow("managed-stop")).catch(
          (error) =>
            log.debug(
              `Post-stop status re-check failed: ${errorMessage(error)}`,
            ),
        );
      }
      await logServerEventBestEffort(
        "server_stop",
        serviceManaged
          ? `Server stopped through ${runtime.serverManager.lifecycleProvider}`
          : "Server stopped via web UI",
      );
      void Promise.resolve(
        runtime.discordBot?.sendEventNotification?.("serverStop", {}),
      ).catch((error) =>
        log.debug(
          `Discord serverStop notification failed: ${errorMessage(error)}`,
        ),
      );
    } else {
      if (typeof runtime.checkServerStatusNow === "function") {
        Promise.resolve(runtime.checkServerStatusNow("graceful-stop")).catch(
          (error) =>
            log.debug(
              `Post-stop status re-check failed: ${errorMessage(error)}`,
            ),
        );
      }
      await logServerEventBestEffort(
        "server_stop",
        "Graceful shutdown requested via web UI",
      );
      result.message =
        result.message || result.response || "Shutdown requested";
      result.confirmed = false;
      monitorGracefulStop(runtime.serverManager, releaseLifecycleLock);
      lifecycleLockTransferred = true;
    }

    return result;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw lifecycleError(errorMessage(error), 500);
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
}

export async function forceStopServerAction(
  runtime: ServerLifecycleRuntime,
  _data: Record<string, any> = {},
) {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "force-stop",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    const response = lifecycleInProgressResponse();
    throw lifecycleError(response.error, 409, response.code);
  }

  try {
    log.info("Force kill requested");
    if (activeServerForLock?.isRemote) {
      throw lifecycleError(
        "Cannot force-stop a remote server. The process is not managed by this panel.",
        400,
        ErrorCode.SERVER_FORCE_STOP_REMOTE_REFUSED,
      );
    }

    const saveOutcome = await attemptBoundedSaveBeforeForceStop(
      runtime.rconService,
    );
    log.info(`Pre-stop save attempt: ${saveOutcome}`);
    runtime.io?.emit?.("server:status", { state: "stopping" });

    const managed = await runManagedLifecycle("stop", {
      serverId: activeServerForLock?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      throw lifecycleError(sanitizeError(managed.error), 502, undefined, {
        saveOutcome,
      });
    }

    const result = managed.handled
      ? { success: true, message: managed.message || "Container stopped." }
      : await runtime.serverManager.stopServer(false, {
          serverId: activeServerForLock?.id ?? null,
        });
    if (!result?.success || result.confirmed === false) {
      throw lifecycleError(
        result?.error || result?.message || "Force stop failed",
        502,
        undefined,
        { ...result, success: false, saveOutcome },
      );
    }

    runtime.serverManager?.markServerStopped?.();
    runtime.io?.emit?.("server:status", { running: false, state: "stopped" });
    if (typeof runtime.checkServerStatusNow === "function") {
      Promise.resolve(runtime.checkServerStatusNow("force-stop")).catch(
        (error) =>
          log.debug(`Post-stop status re-check failed: ${errorMessage(error)}`),
      );
    }
    return { ...result, saveOutcome };
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw lifecycleError(errorMessage(error), 500);
  } finally {
    lifecycleLock.release();
  }
}

export async function restartServerAction(
  runtime: ServerLifecycleRuntime,
  data: Record<string, any> = {},
) {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "restart",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    const response = lifecycleInProgressResponse();
    throw lifecycleError(response.error, 409, response.code);
  }

  let lifecycleLockTransferred = false;
  try {
    if (activeServerForLock?.isRemote) {
      throw lifecycleError(
        "Cannot restart a remote server. The process is not managed by this panel.",
        400,
        ErrorCode.SERVER_RESTART_REMOTE_REFUSED,
      );
    }
    if (runtime.scheduler?.restartInProgress) {
      const response = lifecycleInProgressResponse();
      throw lifecycleError(response.error, 409, response.code);
    }

    let warningMinutes = parseBoundedInteger(
      data.warningMinutes,
      5,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (warningMinutes > 60) warningMinutes = 60;

    autoInstallBridgeIfNeeded(activeServerForLock);
    const restartPromise = Promise.resolve(
      runtime.scheduler.performRestart(warningMinutes, {
        label: "Manual restart",
        lifecycleLock,
      }),
    );
    lifecycleLockTransferred = true;
    void restartPromise
      .then((result) => emitRestartResult(runtime.io, result))
      .catch((error) => {
        log.error(`Restart failed: ${errorMessage(error)}`);
        emitRestartResult(runtime.io, {
          success: false,
          message: errorMessage(error),
        });
      })
      .finally(() => lifecycleLock.release());

    return {
      success: true,
      message:
        warningMinutes > 0
          ? `Restart initiated with ${warningMinutes} minute warning`
          : "Immediate restart initiated",
    };
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw lifecycleError(errorMessage(error), 500);
  } finally {
    if (!lifecycleLockTransferred) lifecycleLock.release();
  }
}

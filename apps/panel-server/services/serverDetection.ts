import { createLogger } from "../utils/logger.ts";
const log = createLogger("ServerDetection");
type AnyRecord = Record<string, any>;
export function classifyStartupProcessState(
  processState: AnyRecord | null | undefined,
) {
  if (
    !processState ||
    processState.scanFailed ||
    typeof processState.running !== "boolean"
  ) {
    return { running: false, unknown: true };
  }
  return { running: processState.running, unknown: false };
}

export async function probeRconFallbackIfConfigured(
  activeServer: AnyRecord | null | undefined,
  rconServiceInstance: AnyRecord,
  timeoutMs: number,
): Promise<boolean> {
  if (!activeServer) {
    log.debug("No server configured yet — skipping RCON port fallback probe");
    return false;
  }

  let rconPortOccupied = false;
  try {
    await rconServiceInstance.loadConfig();
    const rconHost = rconServiceInstance.config.host || "127.0.0.1";
    const rconPort = rconServiceInstance.config.port || 27015;
    const portOpen = await rconServiceInstance.checkPortOpen(
      rconHost,
      rconPort,
    );
    if (portOpen) {
      rconPortOccupied = true;
      log.info(
        `RCON port ${rconHost}:${rconPort} is open even though process check failed — connecting...`,
      );
      try {
        await Promise.race([
          rconServiceInstance.connect(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("RCON connection timeout")),
              timeoutMs,
            ),
          ),
        ]);
        if (rconServiceInstance.connected) {
          log.info("RCON connected via port fallback probe");
        }
      } catch (e: any) {
        log.debug(`Fallback RCON connect failed: ${e.message}`);
      }
    }
  } catch (e: any) {
    log.debug(`Fallback RCON probe error: ${e.message}`);
  }
  return rconPortOccupied;
}

export async function observeServerStatus(
  services: AnyRecord,
  previous: boolean | null,
  reason = "watchdog",
): Promise<boolean | null> {
  const { resolveObservedServerRunning } =
    await import("../utils/serverStatus.ts");
  const running = await resolveObservedServerRunning(
    services.serverManager,
    services.rconService,
    services.dockerClient,
  );
  if (running !== null && previous !== null && running !== previous) {
    log.info(
      `Server state changed → ${running ? "running" : "stopped"} (detected by ${reason})`,
    );
    services.io.emit("server:status", {
      running,
      state: running
        ? services.rconService.connected
          ? "ready"
          : "running-not-ready"
        : "stopped",
    });
    if (!running) {
      const { logServerEvent } = await import("../database/init.ts");
      await logServerEvent(
        "server_stop",
        `Server process exited (detected by ${reason})`,
      );
    }
  }
  return running === null ? previous : running;
}

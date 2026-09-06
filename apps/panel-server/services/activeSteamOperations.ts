import { createLogger } from "../utils/logger.ts";

const log = createLogger("SteamOperations");

export interface SteamOperation {
  type?: string;
  pid?: number;
  startTime?: number;
  lastOutputAt?: number;
  watchdog?: ReturnType<typeof setInterval>;
  branch?: string;
  serverName?: string;
}

const activeSteamOperations = new Map<string, SteamOperation>();
export const STEAM_OPERATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function isSteamOperationIdle(
  operation: SteamOperation | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    operation?.lastOutputAt &&
      now - operation.lastOutputAt >= STEAM_OPERATION_IDLE_TIMEOUT_MS,
  );
}

export function getActiveSteamOperations(): Map<string, SteamOperation> {
  return activeSteamOperations;
}

export function clearActiveSteamOperation(normalizedPath: string): void {
  const operation = activeSteamOperations.get(normalizedPath);
  if (operation?.watchdog) clearInterval(operation.watchdog);
  activeSteamOperations.delete(normalizedPath);
}

export function hasActiveSteamOperation(normalizedPath: string): boolean {
  const operation = activeSteamOperations.get(normalizedPath);
  if (!operation) return false;

  if (Number.isInteger(operation.pid)) {
    try {
      process.kill(operation.pid as number, 0);
      return true;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        clearActiveSteamOperation(normalizedPath);
        log.warn(
          `Cleared stale Steam ${operation.type} operation for ${normalizedPath}`,
        );
        return false;
      }
    }
  }

  return true;
}

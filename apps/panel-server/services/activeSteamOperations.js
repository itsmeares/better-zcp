import { createLogger } from "../utils/logger.js";

const log = createLogger("SteamOperations");

const activeSteamOperations = new Map();
export const STEAM_OPERATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function isSteamOperationIdle(operation, now = Date.now()) {
  return Boolean(
    operation?.lastOutputAt &&
      now - operation.lastOutputAt >= STEAM_OPERATION_IDLE_TIMEOUT_MS,
  );
}

export function getActiveSteamOperations() {
  return activeSteamOperations;
}

export function clearActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (operation?.watchdog) clearInterval(operation.watchdog);
  activeSteamOperations.delete(normalizedPath);
}

export function hasActiveSteamOperation(normalizedPath) {
  const operation = activeSteamOperations.get(normalizedPath);
  if (!operation) return false;

  if (Number.isInteger(operation.pid)) {
    try {
      process.kill(operation.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
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

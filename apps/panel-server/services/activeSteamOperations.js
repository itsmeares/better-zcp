import { createLogger } from "../utils/logger.js";

const log = createLogger("SteamOperations");

// Shared by routes/server.js and serverManager.js so both can coordinate
// SteamCMD work without introducing a circular import. Operations are tracked
// per normalized install path, including the server-start guard.
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

// True if a live SteamCMD process is still tracked for this exact
// normalized path. A tracked-but-dead entry (the process exited without
// this module's own 'close' handler clearing it -- shouldn't normally
// happen, but this must not trust stale bookkeeping either way) is
// verified with a signal-0 liveness probe and self-heals by clearing the
// stale entry rather than reporting a false positive forever.
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

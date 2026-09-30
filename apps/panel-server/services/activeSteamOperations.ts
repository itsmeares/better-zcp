import fs from "node:fs";
import path from "node:path";
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

export function steamInstallKey(installPath: string): string {
  let resolved = path.resolve(installPath);
  try { resolved = fs.realpathSync(resolved); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
  return activeSteamOperations.has(normalizedPath);
}

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";
import { isPidAlive } from "./pidLiveness.ts";

const log = createLogger("Lock");

let lockFilePath: string | null = null;
let released = false;

type LockResult =
  | { acquired: true; lockPath: string | null }
  | {
      acquired: false;
      reason: string;
      existingPid: number | null;
      lockPath: string;
    };

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function parsePid(raw: string): number | null {
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function claimLock(lockPath: string): LockResult {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { acquired: true, lockPath };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;

      let raw: string;
      try {
        raw = fs.readFileSync(lockPath, "utf8").trim();
      } catch (readError: unknown) {
        if (errorCode(readError) === "ENOENT") continue;
        throw readError;
      }

      const existingPid = parsePid(raw);
      if (existingPid === process.pid) {
        return { acquired: true, lockPath };
      }
      if (existingPid !== null && isPidAlive(existingPid)) {
        return {
          acquired: false,
          reason: `another panel instance is already running (pid ${existingPid})`,
          existingPid,
          lockPath,
        };
      }

      log.debug(`Removing stale lock at ${lockPath} (pid ${raw})`);
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError: unknown) {
        if (errorCode(unlinkError) === "ENOENT") continue;
        throw unlinkError;
      }
    }
  }

  return {
    acquired: false,
    reason: "could not safely claim the panel lock",
    existingPid: null,
    lockPath,
  };
}

export function acquireLock(dataDir: string): LockResult {
  const nextLockPath = path.join(dataDir, "panel.lock");
  lockFilePath = nextLockPath;

  try {
    const result = claimLock(nextLockPath);
    if (result.acquired) {
      released = false;
      registerExitHandlers();
    }
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      `Could not create lock file: ${message} — continuing without duplicate-instance protection`,
    );
    lockFilePath = null;
    return { acquired: true, lockPath: null };
  }
}

export function releaseLock(): void {
  if (released || !lockFilePath) return;
  released = true;
  try {
    if (fs.existsSync(lockFilePath)) {
      const raw = fs.readFileSync(lockFilePath, "utf8").trim();
      if (raw === String(process.pid)) {
        fs.unlinkSync(lockFilePath);
      }
    }
  } catch {
    // best-effort
  }
}

let handlersRegistered = false;
function registerExitHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  process.on("exit", releaseLock);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      releaseLock();
      // Let other handlers run; default behaviour will exit.
    });
  }
}

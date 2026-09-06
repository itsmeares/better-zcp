import fs from "fs";
import path from "path";
import { isPidAlive } from "./pidLiveness.ts";

const fileLocks = new Map<string, Promise<void>>();

const TRANSIENT_RENAME_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const RENAME_RETRY_DELAYS_MS = [25, 50, 100];

function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

const ORPHAN_TEMP_PATTERN = /^\.(.+)\.(\d+)\.[0-9a-z]{6}\.tmp$/;

function sweepOrphanWriteTemps(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = ORPHAN_TEMP_PATTERN.exec(name);
    if (!match) continue;
    if (isPidAlive(Number(match[2]))) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* best effort -- another sweep or the original writer may have already cleared it */
    }
  }
}

export function withFileLock<T>(
  filePath: string,
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  const prior = fileLocks.get(key) || Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  fileLocks.set(key, tail);
  tail.finally(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  });
  return run;
}

export function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: fs.WriteFileOptions = "utf-8",
): void {
  const dir = path.dirname(filePath);
  sweepOrphanWriteTemps(dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const explicitMode: fs.Mode | null =
    typeof options === "object" && options !== null && options.mode != null
      ? options.mode
      : null;
  let existingMode: number | null = null;
  if (explicitMode == null) {
    try {
      existingMode = fs.statSync(filePath).mode & 0o777;
    } catch {
      /* no existing target -- nothing to preserve, first-write default stands */
    }
  }

  fs.writeFileSync(tmpPath, data, options);

  if (existingMode != null) {
    const defaultMode = fs.statSync(tmpPath).mode & 0o777;
    try {
      fs.chmodSync(tmpPath, existingMode & defaultMode);
    } catch {
      /* best-effort: Windows / network shares */
    }
  }

  let attempt = 0;
  for (;;) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err: unknown) {
      const errorCode =
        err && typeof err === "object" && "code" in err ? err.code : undefined;
      const canRetry =
        typeof errorCode === "string" &&
        TRANSIENT_RENAME_ERROR_CODES.has(errorCode) &&
        attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!canRetry) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best effort */
        }
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
}

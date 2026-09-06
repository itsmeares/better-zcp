import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const { getDb, commitNow, createDatabaseBackup, setSetting } = await import(
  "../database/init.js"
);
const { getDataPaths } = await import("../utils/paths.js");

const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");
const isWindows = process.platform === "win32";

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

const realWriteFileSync = fs.writeFileSync;

async function waitForConditionFakeTime(check, timeoutMs, description) {
  const stepMs = 25;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
    if (check()) return true;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (check()) return true;
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("db.json / backups — real on-disk mode", () => {
  it.skipIf(isWindows)(
    "db.json lands at 0600 after a flush under a normal umask",
    async () => {
      await getDb();
      const prevUmask = process.umask(0o022);
      try {
        await commitNow();
        expect(mode(dbPath)).toBe(0o600);
      } finally {
        process.umask(prevUmask);
      }
    },
  );

  it.skipIf(isWindows)(
    "db.json stays 0600 even under a permissive umask (000) -- not left at the mercy of the process umask",
    async () => {
      await getDb();
      const prevUmask = process.umask(0o000);
      try {
        await commitNow();
        expect(mode(dbPath)).toBe(0o600);
      } finally {
        process.umask(prevUmask);
      }
    },
  );

  it.skipIf(isWindows)(
    "a database backup file lands at 0600 -- same secrets it copies from db.json",
    async () => {
      await getDb();
      const result = await createDatabaseBackup();
      expect(result.success).toBe(true);
      const backupPath = path.join(backupDir, result.file);
      expect(mode(backupPath)).toBe(0o600);
    },
  );
});

describe("db.json write — crash-safety via fault injection at the write boundary", () => {
  it.skipIf(isWindows)(
    "a fault mid-write leaves db.json exactly as it was -- never truncated or partial",
    async () => {
      await getDb();
      await commitNow();
      const before = fs.readFileSync(dbPath, "utf-8");
      expect(() => JSON.parse(before)).not.toThrow();

      const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
        if (!String(p).includes(path.basename(dbPath))) {
          return realWriteFileSync(p, data, opts);
        }
        const half =
          typeof data === "string" ? data.slice(0, Math.floor(data.length / 2)) : data;
        realWriteFileSync(p, half, opts);
        throw new Error("simulated crash mid-write");
      });

      vi.useFakeTimers();

      await setSetting("crashProbeMarker", "should-not-appear-if-killed-mid-write");
      await commitNow();

      spy.mockRestore();

      const afterCrash = fs.readFileSync(dbPath, "utf-8");
      expect(afterCrash).toBe(before);
      expect(() => JSON.parse(afterCrash)).not.toThrow();

      const casualty = fs
        .readdirSync(dataDir)
        .map((f) => path.join(dataDir, f))
        .find((f) => f !== dbPath && fs.statSync(f).isFile() && f.includes(path.basename(dbPath)));
      expect(casualty, "expected a half-written casualty file from the simulated crash").toBeTruthy();
      const casualtyContent = fs.readFileSync(casualty, "utf-8");
      expect(() => JSON.parse(casualtyContent)).toThrow();

      await waitForConditionFakeTime(
        () => {
          try {
            return (
              JSON.parse(fs.readFileSync(dbPath, "utf-8")).settings.crashProbeMarker ===
              "should-not-appear-if-killed-mid-write"
            );
          } catch {
            return false;
          }
        },
        10000,
        "the scheduled retry to heal db.json",
      );
      const healed = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      expect(healed.settings.crashProbeMarker).toBe("should-not-appear-if-killed-mid-write");

      fs.rmSync(casualty, { force: true });
    },
    10000,
  );
});

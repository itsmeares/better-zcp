import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const { getCircuitBreakerStatus, commitNow, getDb } = await import(
  "../database/init.js"
);
const { getDataPaths } = await import("../utils/paths.ts");

const MAX_WRITE_RETRIES = 5;

function listDbTmpFiles() {
  const { dataDir } = getDataPaths();
  return fs.readdirSync(dataDir).filter((f) => /^db\.json\.\d+\.[0-9a-z]+\.tmp$/i.test(f));
}

describe("flushWrites(): a failed rename cleans up its own tmp file", () => {
  beforeEach(async () => {
    await getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves zero leftover tmp files after ONE failed rename followed by a real success", async () => {
    let renameCalls = 0;
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renameCalls++;
      if (renameCalls === 1) {
        const err = new Error("EPERM: simulated transient rename failure");
        err.code = "EPERM";
        throw err;
      }
      return realRename(...args);
    });

    await commitNow();
    expect(listDbTmpFiles()).toHaveLength(0);

    await commitNow();
    expect(listDbTmpFiles()).toHaveLength(0);
    expect(getCircuitBreakerStatus().open).toBe(false);
  });

  it("leaves zero leftover tmp files across MULTIPLE consecutive failed renames, one per attempt", async () => {
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("EBUSY: simulated persistent rename failure");
      err.code = "EBUSY";
      throw err;
    });

    for (let i = 0; i < MAX_WRITE_RETRIES; i++) {
      await commitNow();
      expect(listDbTmpFiles()).toHaveLength(0);
    }

    spy.mockRestore();
  });

  it("THE HARD REQUIREMENT: retry count, backoff scheduling, and the circuit breaker are UNCHANGED even when the unlink cleanup itself throws", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("ENOSPC: simulated disk full");
      err.code = "ENOSPC";
      throw err;
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("EPERM: cannot even remove the tmp file");
    });

    for (let i = 0; i < MAX_WRITE_RETRIES; i++) {
      await expect(commitNow()).resolves.toBeUndefined();
    }

    const status = getCircuitBreakerStatus();
    expect(status.open).toBe(true);
    expect(status.lastError).toMatch(/ENOSPC/);
    expect(status.failCount).toBe(MAX_WRITE_RETRIES);
    expect(status.cooldownEndsAt).not.toBeNull();
  });

  it("does not touch a real tmp file left by a DIFFERENT (still-live) pid -- only ever unlinks its own attempt's tmp", async () => {
    const { dataDir } = getDataPaths();
    const foreignTmp = path.join(dataDir, `db.json.999999999.abc123.tmp`);
    fs.writeFileSync(foreignTmp, "not mine");

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("EPERM: simulated transient rename failure");
      err.code = "EPERM";
      throw err;
    });

    await commitNow();

    expect(fs.existsSync(foreignTmp)).toBe(true);
    fs.rmSync(foreignTmp);
  });
});

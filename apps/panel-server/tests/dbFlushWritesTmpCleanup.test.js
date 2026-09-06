import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// 2026-08-29, live-evidence hunt: god found four db.json.<pid>.<rand>.tmp
// files (~630KB each) accumulating from a single LIVE process in the real
// data/ directory. flushWrites() computes a brand-new tmpPath on every call
// and never unlinked it on a failed rename -- the next attempt makes a
// fresh tmpPath and never revisits the old one, so every failed rename
// leaked one tmp file, permanently, for as long as the process kept
// retrying. sweepOrphanedTmpFiles() (dead-pid-only, by design) can never
// touch these, because the leak isn't from a crash -- it's from a live
// process's own retry loop.
//
// Real module (not mocked), same convention as circuitBreakerStatus.test.js
// -- getDataPaths() resolves to this FILE's own isolated temp root via
// vitest.perFileDataDir.setup.mjs (applied to every test file), never the
// real repo data/ directory. This is the disposable rig; nothing here ever
// touches the operator's actual data/db.json.
const { getCircuitBreakerStatus, commitNow, getDb } = await import(
  "../database/init.js"
);
const { getDataPaths } = await import("../utils/paths.js");

const MAX_WRITE_RETRIES = 5; // mirrors database/init.js -- not exported, see circuitBreakerStatus.test.js

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

    await commitNow(); // attempt 1: writeFileSync succeeds, renameSync throws -- must clean up
    expect(listDbTmpFiles()).toHaveLength(0); // THE FIX: no orphan from the failed attempt

    await commitNow(); // attempt 2: real success
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
      // Each attempt must clean up after itself -- zero accumulation,
      // never "N attempts so far, N-1 or N leftover tmps".
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
    // The cleanup's own unlink also fails -- the exact case the fix's own
    // try/catch exists for. If the unlink escaped, this would throw out of
    // flushWrites() and _writeRetries would never increment.
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("EPERM: cannot even remove the tmp file");
    });

    for (let i = 0; i < MAX_WRITE_RETRIES; i++) {
      await expect(commitNow()).resolves.toBeUndefined(); // never throws, exactly as before this fix
    }

    // Same assertion shape as circuitBreakerStatus.test.js's own
    // "opens after MAX_WRITE_RETRIES failures" test -- proving this fix
    // changed nothing about that behavior, including in its own worst case.
    const status = getCircuitBreakerStatus();
    expect(status.open).toBe(true);
    expect(status.lastError).toMatch(/ENOSPC/);
    expect(status.failCount).toBe(MAX_WRITE_RETRIES);
    expect(status.cooldownEndsAt).not.toBeNull();
  });

  it("does not touch a real tmp file left by a DIFFERENT (still-live) pid -- only ever unlinks its own attempt's tmp", async () => {
    // A file that looks exactly like this run's own naming convention but
    // is stamped with an unrelated pid, simulating another live instance's
    // in-flight write sharing the same dataDir during a restart overlap.
    const { dataDir } = getDataPaths();
    const foreignTmp = path.join(dataDir, `db.json.999999999.abc123.tmp`);
    fs.writeFileSync(foreignTmp, "not mine");

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("EPERM: simulated transient rename failure");
      err.code = "EPERM";
      throw err;
    });

    await commitNow();

    expect(fs.existsSync(foreignTmp)).toBe(true); // untouched
    fs.rmSync(foreignTmp);
  });
});

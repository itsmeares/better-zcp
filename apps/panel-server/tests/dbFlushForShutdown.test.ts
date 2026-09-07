import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const { flushForShutdown, commitNow, getDb, getCircuitBreakerStatus } =
  await import("../database/init.ts");

describe("flushForShutdown()", () => {
  beforeEach(async () => {
    await getDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await commitNow();
  });

  const SHUTDOWN_FLUSH_MAX_ATTEMPTS = 3;

  it("succeeds on the first attempt when nothing is contending -- the normal shutdown case", async () => {
    await commitNow();

    let renameCalls = 0;
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renameCalls++;
      return realRename(...args);
    });

    const settled = await flushForShutdown();

    expect(settled).toBe(true);
    expect(renameCalls).toBe(0);
  });

  it("retries a transient rename failure and lands the write, well within the bound", async () => {
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

    const { setSetting } = await import("../database/init.ts");
    await setSetting("shutdownFlushProbe", "1");

    const settled = await flushForShutdown();

    expect(settled).toBe(true);
    expect(renameCalls).toBe(2);
  });

  it("THE RISKY HALF: gives up after a bounded number of attempts when the write can NEVER succeed -- proves this cannot hang shutdown forever", async () => {
    let renameCalls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      renameCalls++;
      const err = new Error("ENOSPC: simulated disk full, never recovers");
      err.code = "ENOSPC";
      throw err;
    });

    const { setSetting } = await import("../database/init.ts");
    await setSetting("shutdownFlushProbe", "2");

    const start = Date.now();
    const settled = await flushForShutdown();
    const elapsedMs = Date.now() - start;

    expect(settled).toBe(false);
    expect(renameCalls).toBe(SHUTDOWN_FLUSH_MAX_ATTEMPTS);
    expect(elapsedMs).toBeLessThan(15000);
  });

  it("does not disturb flushWrites()'s own retry/circuit-breaker bookkeeping", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("EBUSY: simulated persistent rename failure");
      err.code = "EBUSY";
      throw err;
    });

    const { setSetting } = await import("../database/init.ts");
    await setSetting("shutdownFlushProbe", "3");

    await flushForShutdown();

    const status = getCircuitBreakerStatus();
    expect(status.lastError).toMatch(/EBUSY/);
    expect(status.failCount).toBe(3);
  });
});

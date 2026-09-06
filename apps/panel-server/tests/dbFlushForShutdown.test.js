import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

// 2026-08-29, shutdown-race follow-up to the flushWrites() tmp-leak find:
// database/init.js's own shutdown() and index.js's gracefulShutdown() are
// two independent, unsynchronized listeners on the same SIGTERM/SIGINT.
// The old shutdown() did exactly ONE flushWrites() attempt -- on failure,
// flushWrites() only SCHEDULES a setTimeout backoff retry and returns
// (correct for a live process that will still be around when the timer
// fires). A process that is exiting is not still going to be around for
// that timer: index.js calls httpServer.close(() => process.exit(0)) on
// its own schedule, and with no lingering connections (the normal clean-
// stop case) that fires well before even the 1s minimum backoff elapses,
// abandoning the retry and silently dropping the operator's pending
// config change. flushForShutdown() replaces the one-shot attempt with a
// bounded, REAL retry loop that something about to exit can actually wait
// out.
//
// Real module (not mocked) -- getDataPaths() resolves to this file's own
// isolated temp root via vitest.perFileDataDir.setup.mjs, never the real
// repo data/ directory.
const { flushForShutdown, commitNow, getDb, getCircuitBreakerStatus } =
  await import("../database/init.js");

describe("flushForShutdown()", () => {
  beforeEach(async () => {
    await getDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // _writeRetries/circuit-breaker state is module-level, not per-test --
    // a test that deliberately ends mid-retry (the "gives up" and
    // "never recovers" cases) must not leak that count into the next
    // test's own assertions. A real, unmocked success is the same reset
    // path a live process would take on its very next successful write.
    await commitNow();
  });

  // mirrors flushForShutdown()'s own SHUTDOWN_FLUSH_MAX_ATTEMPTS -- not
  // exported, same convention as MAX_WRITE_RETRIES in
  // dbFlushWritesTmpCleanup.test.js.
  const SHUTDOWN_FLUSH_MAX_ATTEMPTS = 3;

  it("succeeds on the first attempt when nothing is contending -- the normal shutdown case", async () => {
    // commitNow() marks dirty and flushes once already (real success);
    // flushForShutdown() is what a shutdown listener calls afterwards, and
    // with nothing pending it must return immediately without incurring
    // any retry.
    await commitNow();

    let renameCalls = 0;
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renameCalls++;
      return realRename(...args);
    });

    const settled = await flushForShutdown();

    expect(settled).toBe(true);
    // The property under test is "no retry was needed", not "this was
    // fast" -- a wall-clock assertion here flakes on a busy box for
    // reasons that have nothing to do with the code (2026-08-30: a sibling
    // assertion in this same file tripped at 3138ms vs a 2000ms bound
    // under real CI-comparable contention). Call count is the actual
    // logical property and can't flake under load the way a millisecond
    // threshold can.
    expect(renameCalls).toBe(0); // flushWrites() returns early -- nothing was dirty
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

    // Mark dirty without a real disk write racing commitNow()'s own flush.
    const { setSetting } = await import("../database/init.js");
    await setSetting("shutdownFlushProbe", "1");

    const settled = await flushForShutdown();

    expect(settled).toBe(true); // the retry landed it
    // Bounded by attempt count, not by wall-clock -- see the "THE RISKY
    // HALF" test below for why a millisecond assertion here would flake on
    // a busy box for reasons unrelated to the code.
    expect(renameCalls).toBe(2); // one failure, one real success
  });

  it("THE RISKY HALF: gives up after a bounded number of attempts when the write can NEVER succeed -- proves this cannot hang shutdown forever", async () => {
    let renameCalls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      renameCalls++;
      const err = new Error("ENOSPC: simulated disk full, never recovers");
      err.code = "ENOSPC";
      throw err;
    });

    const { setSetting } = await import("../database/init.js");
    await setSetting("shutdownFlushProbe", "2");

    const start = Date.now();
    const settled = await flushForShutdown();
    const elapsedMs = Date.now() - start;

    expect(settled).toBe(false); // honestly reports it did NOT land
    // THE actual bound being proven: flushForShutdown() made EXACTLY
    // SHUTDOWN_FLUSH_MAX_ATTEMPTS real attempts and stopped -- not
    // flushWrites()'s own exponential backoff (which alone could run past
    // a minute) and not an infinite retry loop. This is a call count, not
    // a clock, so it cannot flake under CPU contention the way the
    // previous version of this test did (2026-08-30: measured 3138ms vs a
    // 2000ms bound on god's gate while running alongside the full client
    // suite -- a real, reproducible contention flake on this exact
    // assertion, not a one-off).
    expect(renameCalls).toBe(SHUTDOWN_FLUSH_MAX_ATTEMPTS);
    // A generous backstop against an actual hang (the thing that would be
    // catastrophic -- see index.js's gracefulShutdown()), not a
    // performance assertion: SHUTDOWN_FLUSH_MAX_ATTEMPTS attempts at
    // ~200ms fixed delay apart is ~400ms of deliberate waiting, so even at
    // several times the worst contention actually observed (3138ms) this
    // has wide margin without being tight enough to flake again. The
    // suite's own global testTimeout (60000ms, vitest.config.js) is the
    // real, unconditional hang backstop; this exists only to fail with a
    // message that says "took too long" instead of vitest's generic
    // "test timed out" if something regresses toward one.
    expect(elapsedMs).toBeLessThan(15000);
  });

  it("does not disturb flushWrites()'s own retry/circuit-breaker bookkeeping", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("EBUSY: simulated persistent rename failure");
      err.code = "EBUSY";
      throw err;
    });

    const { setSetting } = await import("../database/init.js");
    await setSetting("shutdownFlushProbe", "3");

    await flushForShutdown();

    const status = getCircuitBreakerStatus();
    expect(status.lastError).toMatch(/EBUSY/);
    // flushForShutdown() made 3 real attempts (all through flushWrites(),
    // which increments _writeRetries itself each time) -- same counter,
    // same source of truth the storage-health banner already reads.
    expect(status.failCount).toBe(3);
  });
});

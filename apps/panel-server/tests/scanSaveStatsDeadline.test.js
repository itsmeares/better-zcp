import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

// scanSaveStats (apps/panel-server/routes/debug.js) walks a save folder to find stale
// .lock files. Jim measured it taking 10.35s just to reach its own
// MAX_FILES=50,000 cap on an operator-scale save -- LONGER than the 8s
// outer withTimeout() wrapping it at the GET /diagnostics call site, so on
// any large save the check always lost its own race and the whole
// stale-lock check silently vanished from the report (Promise.race's
// timeout fallback is `null`, and `if (saveStats && ...)` just never
// fires -- no error, no "check timed out", nothing).
//
// The fix: scanSaveStats now takes a wall-clock `budgetMs` and checks its
// own deadline before issuing the next readdir/stat, so it self-terminates
// (returning `truncated: true`) well inside the caller's outer timeout,
// instead of relying on that outer race to kill it silently. These tests
// prove that self-termination happens, deterministically -- using a fake
// clock that only individual mocked fs calls advance (never
// vi.advanceTimersByTime), so withTimeout()'s own real setTimeout-based
// fallback timers never spuriously fire and only the deadline check inside
// scanSaveStats's own walk loop can produce a truncated result.

const SAVE_DIR = "C:\\fake-save";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
  vi.spyOn(fs.promises, "access").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const { scanSaveStats } = await import("../routes/debug.js");

describe("scanSaveStats: self-bounded by a wall-clock deadline, not just MAX_FILES", () => {
  it("stops early and reports truncated: true once the budget runs out, well short of visiting every file", async () => {
    const TOTAL_FILES = 200;
    const fileNames = Array.from(
      { length: TOTAL_FILES },
      (_, i) => `chunk${i}.bin`,
    );
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(fileNames);
    // Each stat() "costs" 10ms of simulated wall time -- Date.now() inside
    // scanSaveStats's walk loop will see it, nothing else does.
    vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 10));
      return { isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: Date.now() };
    });

    const result = await scanSaveStats(SAVE_DIR, 50);

    expect(result.truncated).toBe(true);
    // 5 stats fit in a 50ms budget at 10ms each (deadline checked BEFORE
    // each stat, so the 6th never starts) -- deterministic given the mock.
    expect(result.chunks).toBe(5);
    expect(fs.promises.stat).toHaveBeenCalledTimes(5);
    expect(fs.promises.stat).not.toHaveBeenCalledTimes(TOTAL_FILES);
  });

  it("returns truncated: false and visits every file when the budget is ample", async () => {
    const fileNames = ["chunk0.bin", "chunk1.bin", "chunk2.bin"];
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(fileNames);
    vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 10));
      return { isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: Date.now() };
    });

    const result = await scanSaveStats(SAVE_DIR, 10_000);

    expect(result.truncated).toBe(false);
    expect(result.chunks).toBe(3);
    expect(fs.promises.stat).toHaveBeenCalledTimes(3);
  });

  it("recurses into subdirectories but still respects the same deadline across the whole walk", async () => {
    vi.spyOn(fs.promises, "readdir").mockImplementation(async (dir) => {
      if (dir === SAVE_DIR) return ["sub"];
      return Array.from({ length: 100 }, (_, i) => `f${i}.bin`);
    });
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      if (String(p).endsWith("sub")) {
        return { isDirectory: () => true, isFile: () => false };
      }
      vi.setSystemTime(new Date(Date.now() + 10));
      return { isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: Date.now() };
    });

    const result = await scanSaveStats(SAVE_DIR, 50);

    expect(result.truncated).toBe(true);
    // The "sub" directory's own stat doesn't advance the clock, so all 5
    // file-stats still fit before the deadline -- same budget, same math,
    // just one directory level deeper.
    expect(result.chunks).toBe(5);
  });
});

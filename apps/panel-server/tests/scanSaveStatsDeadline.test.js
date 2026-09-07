import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";


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

const { scanSaveStats } = await import("../routes/debug.ts");

describe("scanSaveStats: self-bounded by a wall-clock deadline, not just MAX_FILES", () => {
  it("stops early and reports truncated: true once the budget runs out, well short of visiting every file", async () => {
    const TOTAL_FILES = 200;
    const fileNames = Array.from(
      { length: TOTAL_FILES },
      (_, i) => `chunk${i}.bin`,
    );
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(fileNames);
    vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 10));
      return { isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: Date.now() };
    });

    const result = await scanSaveStats(SAVE_DIR, 50);

    expect(result.truncated).toBe(true);
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
    expect(result.chunks).toBe(5);
  });
});

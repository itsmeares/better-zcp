import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";


const { countDir } = await import("../routes/server.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("countDir: bounded by a wall-clock deadline and an entry cap, not just readdir depth", () => {
  it("stops early and reports truncated: true once the deadline runs out, well short of visiting every file", async () => {
    const TOTAL_FILES = 200;
    const fileNames = Array.from({ length: TOTAL_FILES }, (_, i) => ({
      name: `chunk${i}.bin`,
      isDirectory: () => false,
    }));
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(fileNames);
    vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 10));
      return { size: 1 };
    });

    const budget = { deadline: Date.now() + 50, visited: 0, maxEntries: Infinity, truncated: false };
    const result = await countDir("C:\\fake-save\\map", budget);

    expect(budget.truncated).toBe(true);
    expect(result.files).toBeLessThan(TOTAL_FILES);
    expect(fs.promises.stat).not.toHaveBeenCalledTimes(TOTAL_FILES);
  });

  it("counts every file and reports truncated: false when the budget is ample", async () => {
    const fileNames = ["a.bin", "b.bin", "c.bin"].map((name) => ({
      name,
      isDirectory: () => false,
    }));
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(fileNames);
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 5 });

    const budget = { deadline: Date.now() + 10_000, visited: 0, maxEntries: Infinity, truncated: false };
    const result = await countDir("C:\\fake-save\\map", budget);

    expect(budget.truncated).toBe(false);
    expect(result.files).toBe(3);
    expect(result.size).toBe(15);
  });

  it("recurses into subdirectories but still respects the same shared deadline across the whole walk", async () => {
    vi.spyOn(fs.promises, "readdir").mockImplementation(async (dir) => {
      if (String(dir).endsWith("map")) {
        return [{ name: "0", isDirectory: () => true }];
      }
      return Array.from({ length: 100 }, (_, i) => ({
        name: `f${i}.bin`,
        isDirectory: () => false,
      }));
    });
    vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 10));
      return { size: 1 };
    });

    const budget = { deadline: Date.now() + 50, visited: 0, maxEntries: Infinity, truncated: false };
    const result = await countDir("C:\\fake-save\\map", budget);

    expect(budget.truncated).toBe(true);
    expect(result.files).toBeLessThan(100);
  });

  it("also truncates on the entry-count cap even with a generous deadline", async () => {
    const fileNames = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}.bin`,
      isDirectory: () => false,
    }));
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(fileNames);
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 1 });

    const budget = { deadline: Date.now() + 10_000, visited: 0, maxEntries: 10, truncated: false };
    const result = await countDir("C:\\fake-save\\map", budget);

    expect(budget.truncated).toBe(true);
    expect(result.files).toBeLessThan(50);
  });

  it("a missing/unreadable directory returns zero without touching the shared budget's truncated flag", async () => {
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(new Error("ENOENT"));

    const budget = { deadline: Date.now() + 10_000, visited: 0, maxEntries: Infinity, truncated: false };
    const result = await countDir("C:\\fake-save\\does-not-exist", budget);

    expect(result).toEqual({ files: 0, size: 0 });
    expect(budget.truncated).toBe(false);
  });
});

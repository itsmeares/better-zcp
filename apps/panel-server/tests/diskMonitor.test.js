import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const getSetting = vi.fn();
vi.mock("../database/init.js", () => ({ getActiveServer, getSetting }));

const getDiskFree = vi.fn();
vi.mock("../utils/diskSpace.js", () => ({ getDiskFree }));

const {
  computeDiskStatus,
  statDisk,
  getDiskStatusForPath,
  resolveSaveVolumePath,
  DiskMonitor,
  WARNING_PERCENT,
  CRITICAL_PERCENT,
} = await import("../services/diskMonitor.js");

beforeEach(() => {
  getActiveServer.mockReset();
  getSetting.mockReset();
  getDiskFree.mockReset();
});

describe("computeDiskStatus", () => {
  it("returns a zeroed, non-alerting, not-ok status when the path is missing", () => {
    expect(computeDiskStatus(null, { totalBytes: 100, freeBytes: 10 })).toEqual({
      path: null,
      totalBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      warning: false,
      critical: false,
      ok: false,
    });
  });

  it("returns a zeroed, not-ok status when the disk reading is unavailable", () => {
    // Regression: this used to be identical in shape to a genuinely healthy
    // 0%-used disk, so a stat failure (unreachable mount, permission error)
    // looked exactly like "everything's fine" to every consumer.
    const result = computeDiskStatus("/data", null);
    expect(result.path).toBe("/data");
    expect(result.totalBytes).toBe(0);
    expect(result.warning).toBe(false);
    expect(result.critical).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("computes usedPercent from total/free bytes", () => {
    const result = computeDiskStatus("/data", { totalBytes: 1000, freeBytes: 250 });
    expect(result.usedPercent).toBe(75);
    expect(result.warning).toBe(false);
    expect(result.critical).toBe(false);
  });

  it("flags warning at exactly the warning threshold", () => {
    const result = computeDiskStatus("/data", {
      totalBytes: 1000,
      freeBytes: 1000 - (WARNING_PERCENT / 100) * 1000,
    });
    expect(result.usedPercent).toBe(WARNING_PERCENT);
    expect(result.warning).toBe(true);
    expect(result.critical).toBe(false);
  });

  it("does not flag warning just below the threshold", () => {
    const result = computeDiskStatus("/data", {
      totalBytes: 1000,
      freeBytes: 1000 - (WARNING_PERCENT / 100) * 1000 + 5,
    });
    expect(result.usedPercent).toBeLessThan(WARNING_PERCENT);
    expect(result.warning).toBe(false);
  });

  it("flags critical at exactly the critical threshold", () => {
    const result = computeDiskStatus("/data", {
      totalBytes: 1000,
      freeBytes: 1000 - (CRITICAL_PERCENT / 100) * 1000,
    });
    expect(result.usedPercent).toBe(CRITICAL_PERCENT);
    expect(result.warning).toBe(true);
    expect(result.critical).toBe(true);
  });
});

describe("statDisk", () => {
  it("returns null without calling getDiskFree for an empty path", async () => {
    expect(await statDisk(null)).toBeNull();
    expect(await statDisk("")).toBeNull();
    expect(getDiskFree).not.toHaveBeenCalled();
  });

  it("maps getDiskFree's {free,total} into {freeBytes,totalBytes}", async () => {
    getDiskFree.mockResolvedValue({ free: 100, total: 1000 });
    expect(await statDisk("/data")).toEqual({ totalBytes: 1000, freeBytes: 100 });
  });

  it("returns null when getDiskFree can't determine free space", async () => {
    getDiskFree.mockResolvedValue(null);
    expect(await statDisk("/data")).toBeNull();
  });

  it("returns null when getDiskFree throws", async () => {
    getDiskFree.mockRejectedValue(new Error("ENOENT"));
    expect(await statDisk("/data")).toBeNull();
  });
});

describe("getDiskStatusForPath", () => {
  it("combines statDisk + computeDiskStatus end to end", async () => {
    getDiskFree.mockResolvedValue({ free: 2, total: 100 });
    const result = await getDiskStatusForPath("/save");
    expect(result.path).toBe("/save");
    expect(result.totalBytes).toBe(100);
    expect(result.freeBytes).toBe(2);
    expect(result.critical).toBe(true);
  });
});

describe("resolveSaveVolumePath", () => {
  it("prefers the active server's zomboidDataPath", async () => {
    getActiveServer.mockResolvedValue({ zomboidDataPath: "/mnt/pz-data" });
    expect(await resolveSaveVolumePath()).toBe("/mnt/pz-data");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("falls back to the legacy flat setting when no active server path is set", async () => {
    getActiveServer.mockResolvedValue(null);
    getSetting.mockResolvedValue("/legacy/zomboid");
    expect(await resolveSaveVolumePath()).toBe("/legacy/zomboid");
  });

  it("returns null when neither source has a path", async () => {
    getActiveServer.mockResolvedValue(null);
    getSetting.mockResolvedValue(null);
    expect(await resolveSaveVolumePath()).toBeNull();
  });
});

describe("DiskMonitor", () => {
  let io;

  beforeEach(() => {
    io = { emit: vi.fn() };
  });

  function makeMonitor(statuses) {
    let call = 0;
    const getStatus = vi.fn(async () => statuses[Math.min(call++, statuses.length - 1)]);
    const resolvePath = vi.fn(async () => "/save");
    return new DiskMonitor(io, { resolvePath, getStatus });
  }

  const okStatus = { path: "/save", totalBytes: 100, freeBytes: 50, usedPercent: 50, warning: false, critical: false, ok: true };
  const warnStatus = { path: "/save", totalBytes: 100, freeBytes: 8, usedPercent: 92, warning: true, critical: false, ok: true };
  const critStatus = { path: "/save", totalBytes: 100, freeBytes: 2, usedPercent: 98, warning: true, critical: true, ok: true };
  const unreachableStatus = { path: "/save", totalBytes: 0, freeBytes: 0, usedPercent: 0, warning: false, critical: false, ok: false };

  it("caches the last computed status on getDiskStatus()", async () => {
    const monitor = makeMonitor([okStatus]);
    expect(monitor.getDiskStatus()).toBeNull();
    await monitor.checkNow();
    expect(monitor.getDiskStatus()).toEqual(okStatus);
  });

  it("emits disk:warning only on the transition into warning", async () => {
    const monitor = makeMonitor([okStatus, warnStatus, warnStatus]);
    await monitor.checkNow();
    await monitor.checkNow();
    await monitor.checkNow();
    const warnEmits = io.emit.mock.calls.filter((c) => c[0] === "disk:warning");
    expect(warnEmits).toHaveLength(1);
  });

  it("emits disk:critical on the transition into critical", async () => {
    const monitor = makeMonitor([okStatus, warnStatus, critStatus]);
    await monitor.checkNow();
    await monitor.checkNow();
    await monitor.checkNow();
    expect(io.emit).toHaveBeenCalledWith("disk:critical", critStatus);
  });

  it("emits disk:normal on recovery from warning/critical", async () => {
    const monitor = makeMonitor([critStatus, okStatus]);
    await monitor.checkNow();
    await monitor.checkNow();
    expect(io.emit).toHaveBeenCalledWith("disk:normal", okStatus);
  });

  it("does not report disk:normal when a critical disk becomes unreachable", async () => {
    // Regression: an unreadable stat (mount dropped, disk filled to an I/O
    // error, permissions changed) used to be structurally indistinguishable
    // from a genuinely healthy disk to this method, so the critical banner
    // silently cleared exactly when the disk situation was most dangerous.
    const monitor = makeMonitor([critStatus, unreachableStatus]);
    await monitor.checkNow();
    await monitor.checkNow();
    expect(io.emit).not.toHaveBeenCalledWith("disk:normal", expect.anything());
    expect(io.emit).not.toHaveBeenCalledWith("disk:warning", expect.anything());
  });

  it("still reports disk:normal on genuine recovery after an unreachable stretch", async () => {
    const monitor = makeMonitor([critStatus, unreachableStatus, okStatus]);
    await monitor.checkNow();
    await monitor.checkNow();
    await monitor.checkNow();
    expect(io.emit).toHaveBeenCalledWith("disk:normal", okStatus);
  });

  it("does nothing when io is not provided", async () => {
    const monitor = new DiskMonitor(null, {
      resolvePath: async () => "/save",
      getStatus: async () => critStatus,
    });
    await expect(monitor.checkNow()).resolves.toEqual(critStatus);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const getCircuitBreakerStatus = vi.fn();
vi.mock("../database/init.js", () => ({ getCircuitBreakerStatus }));

const getDiskStatusForPath = vi.fn();
vi.mock("../services/diskMonitor.js", () => ({ getDiskStatusForPath }));

// Not mocked: it's the project's real data-dir resolver, already used
// unmocked elsewhere in the test suite — it only touches the repo's
// gitignored data/ dir, never a real disk anywhere else.
const { getDataPaths } = await import("../utils/paths.js");
const { default: router } = await import("../routes/system.js");
const { buildRuntimeInfo } = await import("../routes/system.js");

const PANEL_DATA_STATUS = {
  path: getDataPaths().dataDir,
  totalBytes: 100,
  freeBytes: 50,
  usedPercent: 50,
  warning: false,
  critical: false,
};

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(diskMonitor) {
  return {
    app: { get: (key) => (key === "diskMonitor" ? diskMonitor : undefined) },
  };
}

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

beforeEach(() => {
  getDiskStatusForPath.mockReset();
  getDiskStatusForPath.mockResolvedValue(PANEL_DATA_STATUS);
  getCircuitBreakerStatus.mockReset();
});

describe("GET /api/system/disk-space", () => {
  it("returns save volume + panel data disk status", async () => {
    const saveVolume = {
      path: "/save",
      totalBytes: 200,
      freeBytes: 10,
      usedPercent: 95,
      warning: true,
      critical: true,
    };
    const diskMonitor = { getDiskStatus: () => saveVolume };
    const response = createResponse();

    await getHandler("/disk-space")(createRequest(diskMonitor), response);

    expect(getDiskStatusForPath).toHaveBeenCalledWith(getDataPaths().dataDir);
    expect(response.json).toHaveBeenCalledWith({
      saveVolume,
      panelData: PANEL_DATA_STATUS,
    });
  });

  it("returns a null saveVolume when the disk monitor hasn't run yet", async () => {
    const diskMonitor = { getDiskStatus: () => null };
    const response = createResponse();

    await getHandler("/disk-space")(createRequest(diskMonitor), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ saveVolume: null }),
    );
  });

  it("returns a null saveVolume when diskMonitor isn't registered on the app", async () => {
    const response = createResponse();

    await getHandler("/disk-space")(createRequest(undefined), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ saveVolume: null }),
    );
  });
});

describe("GET /api/system/storage-health", () => {
  it("combines disk space and circuit breaker status into one payload", async () => {
    const circuitBreaker = {
      open: true,
      lastError: "ENOSPC",
      failCount: 5,
      cooldownEndsAt: "2026-01-01T00:00:00.000Z",
    };
    getCircuitBreakerStatus.mockReturnValue(circuitBreaker);
    const diskMonitor = { getDiskStatus: () => null };
    const response = createResponse();

    await getHandler("/storage-health")(createRequest(diskMonitor), response);

    expect(response.json).toHaveBeenCalledWith({
      diskSpace: { saveVolume: null, panelData: PANEL_DATA_STATUS },
      circuitBreaker,
    });
  });

  it("sanitizes filesystem paths from the circuit breaker error", async () => {
    getCircuitBreakerStatus.mockReturnValue({
      open: true,
      lastError: "ENOSPC writing C:\\Users\\operator\\panel\\data\\db.json",
      failCount: 5,
      cooldownEndsAt: "2026-01-01T00:00:00.000Z",
    });
    const response = createResponse();

    await getHandler("/storage-health")(
      createRequest({ getDiskStatus: () => null }),
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.circuitBreaker.lastError).toContain("ENOSPC");
    expect(payload.circuitBreaker.lastError).not.toContain("Users");
  });

  it("returns a sanitized 500 when a dependency throws", async () => {
    getCircuitBreakerStatus.mockImplementation(() => {
      throw new Error("boom");
    });
    const response = createResponse();

    await getHandler("/storage-health")(
      createRequest({ getDiskStatus: () => null }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

describe("GET /api/system/runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns concrete runtime paths without assuming shell variables", async () => {
    const runtime = buildRuntimeInfo({
      platform: "linux",
      temporaryDirectory: "/run/user/1000/panel tmp",
      environment: { INVOCATION_ID: "service-run" },
      pathSeparator: "/",
      fileExists: () => false,
      restartAssessment: {
        gameServers: "preserved",
        requiresConfirmation: false,
        reason: "test",
      },
    });

    expect(runtime).toEqual({
      platform: "linux",
      family: "posix",
      pathSeparator: "/",
      temporaryDirectory: "/run/user/1000/panel tmp",
      serviceManager: "systemd",
      restartAssessment: {
        gameServers: "preserved",
        requiresConfirmation: false,
        reason: "test",
      },
    });
    expect(JSON.stringify(runtime)).not.toContain("%TEMP%");
  });

  it("uses a neutral family and service manager for unknown platforms", () => {
    // fileExists: () => false only neutralizes the two dockerenv/containerenv
    // marker-file checks. buildRuntimeInfo's container detection now goes
    // through utils/dockerDetect.js's isContainerized(), which -- unmocked --
    // falls back to a REAL fs.readFileSync("/proc/1/cgroup") read of
    // whatever host runs this test. Force the ENOENT branch so this stays
    // hermetic rather than silently depending on the test runner not itself
    // being a container (see the paired positive test below for the case
    // where that fallback DOES fire).
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = new Error(
        "ENOENT: no such file or directory, open '/proc/1/cgroup'",
      );
      err.code = "ENOENT";
      throw err;
    });

    expect(
      buildRuntimeInfo({
        platform: "mystery-os",
        temporaryDirectory: "/custom/tmp",
        environment: {},
        pathSeparator: "/",
        fileExists: () => false,
        restartAssessment: {
          gameServers: "unknown",
          requiresConfirmation: true,
          reason: "test",
        },
      }),
    ).toEqual({
      platform: "mystery-os",
      family: "unknown",
      pathSeparator: "/",
      temporaryDirectory: "/custom/tmp",
      serviceManager: "unknown",
      restartAssessment: {
        gameServers: "unknown",
        requiresConfirmation: true,
        reason: "test",
      },
    });
  });

  // 2026-09-02, single-signal-sweep, REAL DEFECT fix: this endpoint used to
  // hand-roll only the two dockerenv/containerenv marker-file checks (no
  // cgroup fallback) -- the same gap utils/dockerDetect.js's isContainerized()
  // already closed for a "some CI sandboxes, older Docker" runtime that
  // skips the marker file. On such a runtime the OLD code confidently
  // reported serviceManager "none" (or "unknown") instead of "container".
  // Neither marker file exists here (fileExists returns false); only the
  // cgroup scan reveals the container.
  it("reports serviceManager \"container\" via the cgroup fallback even when neither marker file exists", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/docker/abc123\n");

    const runtime = buildRuntimeInfo({
      platform: "linux",
      temporaryDirectory: "/tmp",
      environment: {},
      pathSeparator: "/",
      fileExists: () => false,
      restartAssessment: {
        gameServers: "unknown",
        requiresConfirmation: true,
        reason: "test",
      },
    });

    expect(runtime.serviceManager).toBe("container");
  });
});

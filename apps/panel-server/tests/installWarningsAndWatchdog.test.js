import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { setSetting } from "../database/init.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

vi.mock("../database/init.ts", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

const { writeFileAtomicMock, realHolder } = vi.hoisted(() => ({
  writeFileAtomicMock: vi.fn(),
  realHolder: { fn: null },
}));
vi.mock("../utils/fileWriteQueue.ts", async (importOriginal) => {
  const actual = await importOriginal();
  realHolder.fn = actual.writeFileAtomic;
  return {
    ...actual,
    writeFileAtomic: (...args) => writeFileAtomicMock(...args),
  };
});

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeIoCapturingComplete() {
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const emitted = [];
  const io = {
    emit: vi.fn((event, payload) => {
      emitted.push({ event, payload });
      if (event === "install:complete") resolveComplete(payload);
    }),
  };
  return { io, completePromise, emitted };
}

describe("POST /api/server/install -- warnings array (finding #6) and watchdog message (finding #1)", () => {
  let tmpRoot;
  let installPath;
  let zomboidDataPath;
  let steamcmdPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-test-"));
    installPath = path.join(tmpRoot, "server");
    zomboidDataPath = path.join(tmpRoot, "data");
    steamcmdPath = path.join(tmpRoot, "steamcmd");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.mkdirSync(steamcmdPath, { recursive: true });
    const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");
    fs.writeFileSync(path.join(installPath, "ProjectZomboid64.json"), "{}");

    spawnMock.mockReset();
    writeFileAtomicMock.mockReset();
    writeFileAtomicMock.mockImplementation((...args) => realHolder.fn(...args));
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function baseBody(overrides = {}) {
    return {
      steamcmdPath,
      installPath,
      serverName: "TestServer",
      branch: "public",
      zomboidDataPath,
      adminPassword: "adminpw",
      rconPassword: "rconpassword123",
      rconPort: 27015,
      serverPort: 16261,
      minMemory: 2,
      maxMemory: 4,
      ...overrides,
    };
  }

  it("reports success with an EMPTY warnings array when nothing fails (baseline, proves the plumbing didn't change normal behavior)", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("collects an INSTALL_SETTINGS_SAVE_FAILED warning instead of crashing the panel when saving settings throws, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    vi.mocked(setSetting).mockImplementation(async (key) => {
      if (key === "serverPath") throw new Error("EBUSY: database locked");
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toContainEqual(
      expect.objectContaining({
        progressCode: "INSTALL_SETTINGS_SAVE_FAILED",
        params: expect.objectContaining({ reason: expect.stringContaining("database locked") }),
      }),
    );
  });

  it("collects an INSTALL_SETTINGS_SAVE_FAILED warning when saving the RCON settings throws, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    vi.mocked(setSetting).mockImplementation(async (key) => {
      if (key === "rconPassword") throw new Error("EBUSY: database locked");
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toContainEqual(
      expect.objectContaining({ progressCode: "INSTALL_SETTINGS_SAVE_FAILED" }),
    );
  });

  it("collects an INSTALL_RCON_INI_PRECREATE_FAILED warning instead of silently swallowing the failure, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    writeFileAtomicMock.mockImplementation((targetPath, ...rest) => {
      if (String(targetPath).endsWith(".ini")) {
        throw new Error("EACCES: permission denied");
      }
      return realHolder.fn(targetPath, ...rest);
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toMatchObject({
      progressCode: "INSTALL_RCON_INI_PRECREATE_FAILED",
      params: { reason: expect.stringContaining("permission denied") },
    });
  });

  it("collects an INSTALL_STARTUP_SCRIPT_FAILED warning instead of silently swallowing the failure, and still reports success:true", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });
    writeFileAtomicMock.mockImplementation((targetPath, ...rest) => {
      if (String(targetPath).endsWith(".bat") || String(targetPath).endsWith(".sh")) {
        throw new Error("ENOSPC: no space left on device");
      }
      return realHolder.fn(targetPath, ...rest);
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toMatchObject({
      progressCode: "INSTALL_STARTUP_SCRIPT_FAILED",
      params: { reason: expect.stringContaining("no space left") },
    });
  });

  it("collects an INSTALL_MISSING_GAME_FILES warning when SteamCMD exits 0 but no PZ marker file exists at the install path", async () => {
    fs.rmSync(path.join(installPath, "ProjectZomboid64.json"));

    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toMatchObject({
      progressCode: "INSTALL_MISSING_GAME_FILES",
    });
  });

  it("does NOT warn when a different PZ marker (not ProjectZomboid64.json) is what's actually present -- any one marker is enough", async () => {
    fs.rmSync(path.join(installPath, "ProjectZomboid64.json"));
    fs.writeFileSync(path.join(installPath, "StartServer64.bat"), "");

    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("a watchdog-killed process reports INSTALL_WATCHDOG_KILLED with a real minute count, never the literal word \"null\"", async () => {
    vi.useFakeTimers();
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    fakeProc.kill = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit("close", null));
    });
    spawnMock.mockImplementation(() => fakeProc);

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    const handlerDone = getRouteHandler(router, "/install", "post")(
      { body: baseBody(), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    await handlerDone;

    const payload = await completePromise;
    expect(fakeProc.kill).toHaveBeenCalled();
    expect(payload.success).toBe(false);
    expect(payload.progressCode).toBe("INSTALL_WATCHDOG_KILLED");
    expect(payload.message).not.toContain("exit code null");
    expect(payload.params).toEqual({ minutes: 10 });
  });
});

// global legacy setting (setSetting("useUpnp", ...)) that nothing ever
describe("POST /api/server/install -- UPnP reaches the server's own .ini, not just a global setting nothing reads", () => {
  let tmpRoot;
  let installPath;
  let zomboidDataPath;
  let steamcmdPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-install-upnp-test-"));
    installPath = path.join(tmpRoot, "server");
    zomboidDataPath = path.join(tmpRoot, "data");
    steamcmdPath = path.join(tmpRoot, "steamcmd");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(zomboidDataPath, { recursive: true });
    fs.mkdirSync(steamcmdPath, { recursive: true });
    const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");

    spawnMock.mockReset();
    writeFileAtomicMock.mockReset();
    writeFileAtomicMock.mockImplementation((...args) => realHolder.fn(...args));
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockImplementation(async () => {});
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function baseBody(overrides = {}) {
    return {
      steamcmdPath,
      installPath,
      serverName: "UpnpTestServer",
      branch: "public",
      zomboidDataPath,
      serverPort: 16261,
      minMemory: 2,
      maxMemory: 4,
      ...overrides,
    };
  }

  function iniPath() {
    return path.join(zomboidDataPath, "Server", "UpnpTestServer.ini");
  }

  it("writes UPnP=false into the pre-created ini even with NO rcon password given -- previously the whole ini pre-create was skipped in this case", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      { body: baseBody({ useUpnp: false }), app: { get: (k) => (k === "io" ? io : undefined) } },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    const content = fs.readFileSync(iniPath(), "utf-8");
    expect(content).toContain("UPnP=false");
    expect(content).not.toContain("RCONPassword=");
  });

  it("writes UPnP=true and the RCON credentials together into the SAME pre-created ini when both are given", async () => {
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    const { default: router } = await import("../routes/server.ts");
    const { io, completePromise } = fakeIoCapturingComplete();
    const res = createResponse();
    await getRouteHandler(router, "/install", "post")(
      {
        body: baseBody({ useUpnp: true, rconPassword: "rconpw123", rconPort: 27015 }),
        app: { get: (k) => (k === "io" ? io : undefined) },
      },
      res,
    );

    const payload = await completePromise;
    expect(payload.success).toBe(true);
    const content = fs.readFileSync(iniPath(), "utf-8");
    expect(content).toContain("UPnP=true");
    expect(content).toContain("RCONPassword=rconpw123");
    expect(content).toContain("RCONPort=27015");
  });
});

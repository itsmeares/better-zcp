import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-02, bridge-enforcement: autoInstallBridgeIfNeeded() used to run
// ONLY on POST /:id/activate (routes/servers.js) -- an uncommon "reassign
// the active server profile" action -- never on an ordinary POST
// /server/start or POST /server/restart. PZ loads Lua at Java-process
// startup, so a server that's simply restarted (the common case: crash
// recovery, scheduled restarts, manual restarts) never got its on-disk
// bridge file rechecked at all, no matter how far it drifted from the
// shipped source (2026-09-02 bridge-install-integrity audit). These tests
// assert the ORDER, not just that both things happened: a test that mocks a
// bridge already up to date passes on the broken code too, so every test
// here starts from a genuinely STALE on-disk file and checks it is already
// current by the time the spawn call fires -- a fresher file written
// afterward is invisible to the JVM until its NEXT restart.

let activeServer;
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => activeServer),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({ runManagedLifecycle }));

const { default: router } = await import("../routes/server.js");
const { resolveSourcePath } = await import(
  "../services/panelBridgeInstaller.js"
);

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // requirePermission is applied inline per-route in server.js, so the real
  // handler is the LAST entry in this route's middleware stack.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeStartApp(overrides = {}) {
  const values = {
    serverManager: {
      getServerProcessDetails: vi.fn(async () => ({
        running: false,
        scanFailed: false,
      })),
    },
    rconService: {
      serverStarting: false,
      connected: false,
      config: { host: "127.0.0.1", port: 27015 },
      loadConfig: vi.fn(async () => {}),
      checkPortOpen: vi.fn(async () => true),
      connect: vi.fn(async function () {
        this.connected = true;
      }),
      forceResetConnectionState: vi.fn(),
    },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    ...overrides,
  };
  return { get: (key) => values[key], _values: values };
}

let tmpDir;
const targetLua = () =>
  path.join(tmpDir, "media", "lua", "server", "PanelBridge.lua");
const bundledContent = () => fs.readFileSync(resolveSourcePath(), "utf8");
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-autoinstall-route-"));
  runManagedLifecycle.mockReset();
  // Docker-managed path (handled: true) sidesteps /start's 30s local-process
  // poll entirely -- see dockerStartStatusPush.test.js, same reasoning.
  // installPath is real so the installer's own fs writes land somewhere
  // disposable; no serverName/zomboidDataPath keeps
  // refreshLaunchTargetBeforeStart()'s ensureRconConfigured() call a
  // harmless no-op.
  activeServer = { id: "s1", name: "Test Server", installPath: tmpDir, isRemote: false };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /server/start -- bridge auto-install runs before the process spawns", () => {
  it("has already overwritten a stale bridge by the time runManagedLifecycle spawns the container", async () => {
    fs.mkdirSync(path.dirname(targetLua()), { recursive: true });
    fs.writeFileSync(targetLua(), 'local VERSION = "0.0.1"\n');

    let contentAtSpawnTime;
    runManagedLifecycle.mockImplementation(async () => {
      contentAtSpawnTime = fs.readFileSync(targetLua(), "utf8");
      return { handled: true, success: true, message: "Container starting" };
    });

    const app = makeStartApp();
    const response = createResponse();
    await getHandler("/start", "post")({ app }, response);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(contentAtSpawnTime).toBe(bundledContent());
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("leaves an already-current bridge untouched (no needless rewrite on every start)", async () => {
    fs.mkdirSync(path.dirname(targetLua()), { recursive: true });
    fs.writeFileSync(targetLua(), bundledContent());
    const mtimeBefore = fs.statSync(targetLua()).mtimeMs;

    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container starting",
    });

    const app = makeStartApp();
    const response = createResponse();
    await getHandler("/start", "post")({ app }, response);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fs.statSync(targetLua()).mtimeMs).toBe(mtimeBefore);
  });

  it("still starts the server when the bridge install itself fails", async () => {
    // "media" as a plain file forces installBridge()'s directory creation to
    // fail with ENOTDIR -- same shape panelBridgeInstaller.test.js uses.
    fs.writeFileSync(path.join(tmpDir, "media"), "not a directory");

    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container starting",
    });

    const app = makeStartApp();
    const response = createResponse();
    await getHandler("/start", "post")({ app }, response);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(runManagedLifecycle).toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});

describe("POST /server/restart -- bridge auto-install runs before performRestart respawns it", () => {
  it("has already overwritten a stale bridge by the time performRestart runs", async () => {
    fs.mkdirSync(path.dirname(targetLua()), { recursive: true });
    fs.writeFileSync(targetLua(), 'local VERSION = "0.0.1"\n');

    let contentAtSpawnTime;
    const performRestart = vi.fn(async () => {
      contentAtSpawnTime = fs.readFileSync(targetLua(), "utf8");
      return { success: true, message: "Restarted successfully" };
    });
    const app = {
      get: (key) =>
        key === "scheduler"
          ? { performRestart }
          : key === "io"
            ? { emit: vi.fn() }
            : null,
    };
    const response = createResponse();

    await getHandler("/restart", "post")({ body: {}, app }, response);
    await flushMicrotasks();

    expect(contentAtSpawnTime).toBe(bundledContent());
  });

  it("still accepts the restart when the bridge install itself fails", async () => {
    fs.writeFileSync(path.join(tmpDir, "media"), "not a directory");

    const performRestart = vi.fn(async () => ({
      success: true,
      message: "Restarted successfully",
    }));
    const app = {
      get: (key) =>
        key === "scheduler"
          ? { performRestart }
          : key === "io"
            ? { emit: vi.fn() }
            : null,
    };
    const response = createResponse();

    await getHandler("/restart", "post")({ body: {}, app }, response);
    await flushMicrotasks();

    expect(performRestart).toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});

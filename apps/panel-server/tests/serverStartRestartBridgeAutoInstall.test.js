import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


let activeServer;
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => activeServer),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.ts", () => ({ runManagedLifecycle }));

const { default: router } = await import("../routes/server.js");
const { resolveSourcePath } = await import(
  "../services/panelBridgeInstaller.ts"
);

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
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

import { beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({
    id: "docker-server",
    isRemote: false,
    dockerContainerName: "pz-container",
    // Deliberately no serverName/zomboidDataPath/rconPassword: keeps
    // refreshLaunchTargetBeforeStart()'s ensureRconConfigured() call a
    // real, harmless no-op (returns false before touching the filesystem)
    // instead of needing its own mock.
  })),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.ts", () => ({ runManagedLifecycle }));

const { default: router } = await import("../routes/server.js");

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

function makeApp(overrides = {}) {
  const values = {
    serverManager: {
      getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
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

describe("POST /start -- Docker start pushes server:status immediately", () => {
  beforeEach(() => {
    runManagedLifecycle.mockReset();
  });

  it("emits server:status:{running:true} synchronously for a managed container start, without touching the local process scan", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: true,
      message: "Container starting",
    });
    const app = makeApp();
    const response = createResponse();

    await getHandler("/start", "post")({ app }, response);
    await Promise.resolve();
    await Promise.resolve();

    expect(app._values.io.emit).toHaveBeenCalledWith("server:status", { running: true });
    expect(app._values.serverManager.getServerProcessDetails).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("does not emit for a managed container start that Docker itself reports as failed", async () => {
    runManagedLifecycle.mockResolvedValue({
      handled: true,
      success: false,
      error: "Docker action failed",
    });
    const app = makeApp();
    const response = createResponse();

    await getHandler("/start", "post")({ app }, response);

    expect(app._values.io.emit).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(502);
  });
});

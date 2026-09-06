import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 1 finding (Oscar, 2026-08-29): POST /start's 1s-cadence poll loop
// called serverManager.getServerProcessDetails() -- a LOCAL host process
// scan -- unconditionally, even when runManagedLifecycle("start") already
// launched the server through Docker. For docker-local/docker-managed
// servers, PZ runs as PID 1 of a *different* container, so that scan can
// never see it (GH#114). The poll ran its full 30 attempts, never detected
// running:true, and on timeout just logged a warning -- no server:status
// event ever fired for a Docker start. The client fell back entirely to its
// own 10-15s polling.
//
// Fixed: when runManagedLifecycle("start") reports managed.handled, emit
// server:status:{running:true} immediately (Docker's own start action
// already confirms the container is up before returning -- same trust the
// existing /stop and /force-stop routes already place in Docker's stop
// action) and skip the doomed local-scan poll entirely for this path.

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
vi.mock("../services/managedContainer.js", () => ({ runManagedLifecycle }));

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
    // waitForRconAfterStart() is deliberately fire-and-forgotten by the
    // route (the HTTP response must not wait out RCON's up-to-5-minute
    // readiness poll) -- flush pending microtasks so its already-resolved
    // mock calls (checkPortOpen/connect both resolve immediately, so its
    // loop breaks on the first iteration with no real timer) settle before
    // the test ends, rather than leaving it silently still in flight.
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

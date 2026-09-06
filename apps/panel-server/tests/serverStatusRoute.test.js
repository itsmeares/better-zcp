import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
}));

const fakeBridge = { bridgePath: null, isRunning: false, isModConnected: () => false };
vi.mock("../services/panelBridge.js", () => ({ default: fakeBridge }));

const resolveDockerHostSignal = vi.fn(async () => ({ running: false, scanFailed: true }));
vi.mock("../services/managedContainer.js", () => ({ resolveDockerHostSignal }));

const { default: router } = await import("../routes/serverStatus.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getStatusHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/active/status" && entry.route.methods.get,
  );
  return layer.route.stack[0].handle;
}

function fakeApp(overrides = {}) {
  const services = {
    serverManager: {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    },
    rconService: { getConfig: () => ({ connected: false }), connecting: false },
    ...overrides,
  };
  return { get: (key) => services[key] };
}

describe("GET /api/servers/active/status", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    resolveDockerHostSignal.mockReset();
    resolveDockerHostSignal.mockResolvedValue({ running: false, scanFailed: true });
    fakeBridge.bridgePath = null;
    fakeBridge.isRunning = false;
    fakeBridge.isModConnected = () => false;
  });

  it("returns 404 when no server is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(response.status).toHaveBeenCalledWith(404);
  });

  it("reports container running but RCON disconnected without collapsing to one flag", async () => {
    getActiveServer.mockResolvedValue({ id: 1, isRemote: false });
    fakeBridge.bridgePath = "/data/panelbridge";
    const response = createResponse();

    await getStatusHandler()(
      {
        app: fakeApp({
          serverManager: {
            getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
          },
          rconService: {
            getConfig: () => ({ connected: false, host: "127.0.0.1", port: 27015 }),
            connecting: false,
          },
        }),
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "native",
        selected: true,
        host: expect.objectContaining({ status: "running" }),
        server: expect.objectContaining({ status: "disconnected" }),
        bridge: expect.objectContaining({ status: "offline" }),
      }),
    );
  });

  it("uses Docker container state instead of the host process scan", async () => {
    getActiveServer.mockResolvedValue({
      id: "docker-server",
      dockerContainerName: "pz-container",
      isRemote: false,
    });
    resolveDockerHostSignal.mockResolvedValue({ running: true, scanFailed: false });
    const processScan = vi.fn(async () => ({ running: false, scanFailed: false }));
    const response = createResponse();

    await getStatusHandler()(
      {
        app: fakeApp({
          serverManager: { getServerProcessDetails: processScan },
        }),
      },
      response,
    );

    expect(resolveDockerHostSignal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "docker-server", dockerContainerName: "pz-container" }),
      undefined,
    );
    expect(processScan).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "docker-local",
        host: expect.objectContaining({
          status: "running",
          label: "Container",
        }),
      }),
    );
  });

  it("reports an unverifiable Docker state as unknown instead of stopped", async () => {
    getActiveServer.mockResolvedValue({
      id: "docker-server",
      dockerContainerName: "missing-container",
      isRemote: false,
    });
    resolveDockerHostSignal.mockResolvedValue({ running: false, scanFailed: true });
    const processScan = vi.fn(async () => ({ running: false, scanFailed: false }));
    const response = createResponse();

    await getStatusHandler()(
      {
        app: fakeApp({
          serverManager: { getServerProcessDetails: processScan },
        }),
      },
      response,
    );

    expect(processScan).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        host: expect.objectContaining({ status: "unknown" }),
      }),
    );
  });

  it("reports the host as unknown, not stopped, when process detection itself failed", async () => {
    getActiveServer.mockResolvedValue({ id: 1, isRemote: false });
    const response = createResponse();

    await getStatusHandler()(
      {
        app: fakeApp({
          serverManager: {
            isRunning: false, // stale cached field -- must not be trusted
            getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
          },
        }),
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        host: expect.objectContaining({ status: "unknown" }),
      }),
    );
  });

  it("reports an active bridge only when running and mod-connected", async () => {
    getActiveServer.mockResolvedValue({ id: 1, isRemote: false });
    fakeBridge.bridgePath = "/data/panelbridge";
    fakeBridge.isRunning = true;
    fakeBridge.isModConnected = () => true;
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ bridge: expect.objectContaining({ status: "active" }) }),
    );
  });


  it("does not attempt a Docker lookup for a native server", async () => {
    getActiveServer.mockResolvedValue({ id: 1, isRemote: false });
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(resolveDockerHostSignal).not.toHaveBeenCalled();
  });

  it("returns 500 with a sanitized error when the database lookup throws", async () => {
    getActiveServer.mockRejectedValue(new Error("db exploded"));
    const response = createResponse();

    await getStatusHandler()({ app: fakeApp() }, response);

    expect(response.status).toHaveBeenCalledWith(500);
  });
});

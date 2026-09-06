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

  // The direct-inspect vs. resolveManagedContainer-fallback distinction
  // (and the inspectManagedContainer call itself) now lives entirely in
  // resolveDockerHostSignal() -- see apps/panel-server/tests/managedContainer.test.js
  // for that coverage. This route is only responsible for turning whatever
  // resolveDockerHostSignal answers into the right host signal, and for
  // never falling back to the local process scan for a container provider
  // (GH#114).
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

  // Regression: this route used to read the cached serverManager.isRunning
  // field directly. That field gets forced to a confident `false` by ANY
  // failed process-detection scan (see serverManager.js), so once detection
  // started failing on a host, this endpoint -- which feeds the dashboard's
  // host badge -- kept confidently reporting "stopped" while a fresh check
  // in the same moment (e.g. /wipe's own guard) correctly refused because it
  // could not tell. Same underlying scan, two different answers. This must
  // call getServerProcessDetails() itself so it sees the SAME scanFailed
  // fresh, not a stale cached boolean.
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

  // GH#114: PZ in its own container, panel in another (docker.sock mounted,
  // PANEL_DOCKER_CONTROL_ENABLED=true, dockerContainerName set). The local
  // process scan can never see a process outside this container and
  // correctly returns running: false -- the bug was reading that scan for
  // WATCH FOR in GH#114: a profile with dockerContainerName set on a host
  // where Docker control is disabled or the socket is absent must degrade to
  // unknown, not crash and not silently fall back to the local process scan
  // (which would just reintroduce the same bug). Covered above for both
  // outcomes ("uses Docker container state..." / "reports an unverifiable
  // Docker state..."); resolveDockerHostSignal() itself (apps/panel-server/tests/
  // managedContainer.test.js) is what's actually responsible for degrading
  // to scanFailed:true when Docker control is disabled or the mapped
  // container isn't found, not this route.

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

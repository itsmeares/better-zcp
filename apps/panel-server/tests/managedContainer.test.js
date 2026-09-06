import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServer, getActiveServer } = vi.hoisted(() => ({
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({ getServer, getActiveServer }));

const { runManagedLifecycle, resolveManagedContainer, resolveDockerHostSignal, setDockerClient } =
  await import("../services/managedContainer.js");

function createClient(overrides = {}) {
  return {
    enabled: true,
    available: true,
    inspectManagedContainer: vi.fn(async () => ({ State: { Running: true } })),
    runManagedAction: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

beforeEach(() => {
  getServer.mockReset();
  getActiveServer.mockReset();
  setDockerClient(null);
});

describe("resolveManagedContainer", () => {
  it("declines when Docker control is disabled", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({ enabled: false });

    expect(await resolveManagedContainer({ dockerClient: client })).toEqual({
      handled: false,
    });
    expect(client.inspectManagedContainer).not.toHaveBeenCalled();
  });

  it("declines when the socket is not reachable", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });

    expect(
      await resolveManagedContainer({ dockerClient: createClient({ available: false }) }),
    ).toEqual({ handled: false });
  });

  it("declines when the server maps no container", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", dockerContainerName: null });

    expect(await resolveManagedContainer({ dockerClient: createClient() })).toEqual({
      handled: false,
    });
  });

  it("falls back to the container id when no name is mapped", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerId: "abc123" });
    const client = createClient();

    const resolved = await resolveManagedContainer({ dockerClient: client });

    expect(client.inspectManagedContainer).toHaveBeenCalledWith("abc123");
    expect(resolved.ref).toBe("abc123");
  });

  it("reads the pinned server rather than the active one when given an id", async () => {
    getServer.mockResolvedValue({ dockerContainerName: "pinned" });
    const client = createClient();

    await resolveManagedContainer({ serverId: "s9", dockerClient: client });

    expect(getServer).toHaveBeenCalledWith("s9");
    expect(getActiveServer).not.toHaveBeenCalled();
  });

  it("claims the action but fails when the mapped container is unmanageable", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({ inspectManagedContainer: vi.fn(async () => null) });

    const resolved = await resolveManagedContainer({ dockerClient: client });

    // Must not decline: falling back to RCON would kill the process and let the
    // restart policy bring the container straight back up.
    expect(resolved.handled).toBe(true);
    expect(resolved.error).toMatch(/zomboid-panel\.managed=true/);
  });
});

describe("runManagedLifecycle", () => {
  it("stops through Docker instead of the process path", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();

    const result = await runManagedLifecycle("stop", { dockerClient: client });

    expect(client.runManagedAction).toHaveBeenCalledWith("pz", "stop");
    expect(result).toEqual({ handled: true, success: true });
  });

  it("treats an already stopped container as a successful stop", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
    });

    const result = await runManagedLifecycle("stop", { dockerClient: client });

    expect(client.runManagedAction).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("treats an already running container as a successful start", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();

    const result = await runManagedLifecycle("start", { dockerClient: client });

    expect(client.runManagedAction).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.alreadyRunning).toBe(true);
  });

  it("restarts a running container through Docker", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();

    await runManagedLifecycle("restart", { dockerClient: client });

    expect(client.runManagedAction).toHaveBeenCalledWith("pz", "restart");
  });

  it("surfaces a Docker failure instead of silently declining", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient({
      runManagedAction: vi.fn(async () => ({ success: false, error: "Docker action failed" })),
    });

    expect(await runManagedLifecycle("stop", { dockerClient: client })).toEqual({
      handled: true,
      success: false,
      error: "Docker action failed",
    });
  });

  it("uses the client wired through setDockerClient", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });
    const client = createClient();
    setDockerClient(client);

    await runManagedLifecycle("stop");

    expect(client.runManagedAction).toHaveBeenCalledWith("pz", "stop");
  });

  it("declines when no client has been wired at all", async () => {
    getActiveServer.mockResolvedValue({ dockerContainerName: "pz" });

    expect(await runManagedLifecycle("stop")).toEqual({ handled: false });
  });
});

// resolveDockerHostSignal is the single implementation apps/panel-server/routes/
// serverStatus.js's dashboard badge and apps/panel-server/index.js's status watchdog
// (checkServerStatusNow) both call for docker-local/docker-managed servers,
// so a bug here would desync both at once -- see its own header comment.
describe("resolveDockerHostSignal", () => {
  it("inspects a directly-referenced container without requiring the managed label", async () => {
    const client = createClient({
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: true } })),
    });

    const result = await resolveDockerHostSignal(
      { id: 1, dockerContainerName: "pz-container" },
      client,
    );

    expect(client.inspectManagedContainer).toHaveBeenCalledWith("pz-container");
    expect(result).toEqual({ running: true, scanFailed: false });
  });

  it("falls back to the container id when no name is mapped", async () => {
    const client = createClient({
      inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
    });

    const result = await resolveDockerHostSignal(
      { id: 1, dockerContainerId: "abc123" },
      client,
    );

    expect(client.inspectManagedContainer).toHaveBeenCalledWith("abc123");
    expect(result).toEqual({ running: false, scanFailed: false });
  });

  it("reports scanFailed when a directly-referenced container can't be found", async () => {
    const client = createClient({ inspectManagedContainer: vi.fn(async () => null) });

    const result = await resolveDockerHostSignal(
      { id: 1, dockerContainerName: "pz-container" },
      client,
    );

    expect(result).toEqual({ running: false, scanFailed: true });
  });

  // Docker control disabled/unavailable -- falls through to
  // resolveManagedContainer(), which declines the same way (both share the
  // identical enabled/available guard), so the outcome is the same
  // scanFailed:true either way. This reuses the REAL resolveManagedContainer
  // (not mocked), so a regression in how the two functions compose would
  // also be caught here.
  it("reports scanFailed when Docker control is disabled (falls through to resolveManagedContainer, which also declines)", async () => {
    const client = createClient({ enabled: false, available: false });

    const result = await resolveDockerHostSignal({ id: 1, dockerContainerName: "pz" }, client);

    expect(client.inspectManagedContainer).not.toHaveBeenCalled();
    expect(result).toEqual({ running: false, scanFailed: true });
  });

  // No ref on the server object at all -- both the direct-inspect condition
  // and resolveManagedContainer's own ref lookup (server.dockerContainerName
  // /dockerContainerId, re-fetched via getServer(id)) come up empty.
  it("reports scanFailed when the server carries no container reference at all", async () => {
    getServer.mockResolvedValue({ dockerContainerName: null, dockerContainerId: null });
    const client = createClient();

    const result = await resolveDockerHostSignal({ id: 1, provider: "docker-managed" }, client);

    expect(client.inspectManagedContainer).not.toHaveBeenCalled();
    expect(getServer).toHaveBeenCalledWith(1);
    expect(result).toEqual({ running: false, scanFailed: true });
  });
});

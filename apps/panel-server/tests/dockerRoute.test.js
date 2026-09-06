import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServer, connect, save, disconnect } = vi.hoisted(() => ({
  getServer: vi.fn(),
  connect: vi.fn(),
  save: vi.fn(),
  disconnect: vi.fn(),
}));

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// docker.js now gates with requirePermission("docker.manage") (DB-backed
// capability lookup) instead of requireRole -- getRoleByName needs mocking
// alongside getServer. The old hand-rolled requireRole mock (admin-only) is
// gone: docker.js doesn't import from services/auth.js at all anymore.
vi.mock("../database/init.js", () => ({ getServer, getRoleByName: mockGetRoleByName }));
vi.mock("../services/rcon.js", () => ({
  RconService: class {
    connected = false;
    async loadConfig() {}
    async connect() {
      this.connected = await connect();
      return this.connected;
    }
    save = save;
    disconnect = disconnect;
  },
}));

const { default: router } = await import("../routes/docker.js");

beforeEach(() => {
  getServer.mockReset();
  connect.mockReset();
  save.mockReset();
  disconnect.mockReset();
  disconnect.mockResolvedValue(undefined);
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runRoute(routePath, method, request, response) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
}

describe("GET /api/docker/status", () => {
  it("rejects non-admin callers", async () => {
    const response = createResponse();
    const listManagedContainers = vi.fn();

    await runRoute("/status", "get",
      { user: { role: "viewer" }, app: { get: () => ({ enabled: true, listManagedContainers }) } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(listManagedContainers).not.toHaveBeenCalled();
  });

  it("reports only the managed containers supplied by the client", async () => {
    const response = createResponse();
    await runRoute("/status", "get",
      {
        user: { role: "admin" },
        app: {
          get: () => ({
            enabled: true,
            available: true,
            listManagedContainers: vi.fn(async () => [{
              Id: "managed-id",
              Names: ["/pz-managed"],
              Image: "custom/pz",
              State: "running",
              Status: "Up 2 minutes",
            }]),
          }),
        },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith({
      enabled: true,
      available: true,
      containers: [{
        id: "managed-id",
        name: "pz-managed",
        image: "custom/pz",
        state: "running",
        status: "Up 2 minutes",
      }],
    });
  });
});

describe("POST /api/docker/containers/:id/:action", () => {
  it("rejects a non-admin caller before invoking Docker", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn();

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "viewer" },
      params: { id: "managed", action: "restart" },
      app: { get: () => ({ enabled: true, available: true, runManagedAction }) },
    }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(runManagedAction).not.toHaveBeenCalled();
  });

  it("only runs an action through the managed-container client", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn(async () => ({ success: true }));
    const inspectManagedContainer = vi.fn(async () => ({ State: { Running: true } }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });
    connect.mockResolvedValue(true);
    save.mockResolvedValue({ success: true });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => ({ enabled: true, available: true, inspectManagedContainer, runManagedAction }) },
    }, response);

    expect(runManagedAction).toHaveBeenCalledWith("managed", "restart");
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  it("does not stop a container when the world save fails", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn();
    const inspectManagedContainer = vi.fn(async () => ({ State: { Running: true } }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });
    connect.mockResolvedValue(true);
    save.mockResolvedValue({ success: false, error: "timeout" });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "stop" },
      body: { serverId: "server-1" },
      app: { get: () => ({ enabled: true, available: true, inspectManagedContainer, runManagedAction }) },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(runManagedAction).not.toHaveBeenCalled();
  });

  it("restarts a stopped managed container without requiring RCON", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn(async () => ({ success: true }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "restart" },
      body: { serverId: "server-1" },
      app: { get: () => ({
        enabled: true,
        available: true,
        inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
        runManagedAction,
      }) },
    }, response);

    expect(connect).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(runManagedAction).toHaveBeenCalledWith("managed", "restart");
  });

  it("passes through the real Docker error instead of a generic message, with any path redacted", async () => {
    const response = createResponse();
    const runManagedAction = vi.fn(async () => ({
      success: false,
      error: "connect EACCES /var/run/docker.sock",
    }));
    getServer.mockResolvedValue({ id: "server-1", dockerContainerName: "managed" });

    await runRoute("/containers/:id/:action", "post", {
      user: { role: "admin" },
      params: { id: "managed", action: "start" },
      body: { serverId: "server-1" },
      app: { get: () => ({
        enabled: true,
        available: true,
        inspectManagedContainer: vi.fn(async () => ({ State: { Running: false } })),
        runManagedAction,
      }) },
    }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    const payload = response.json.mock.calls[0][0];
    expect(payload.error).toMatch(/EACCES/);
    expect(payload.error).not.toContain("/var/run/docker.sock");
  });
});

describe("GET /api/docker/stats", () => {
  it("samples only managed containers returned by the Docker client", async () => {
    const response = createResponse();
    const getContainerStats = vi.fn(async () => ({ cpuPercent: 12.5 }));

    await runRoute("/stats", "get", {
      user: { role: "admin" },
      app: {
        get: () => ({
          enabled: true,
          available: true,
          listManagedContainers: vi.fn(async () => [{ Id: "managed", Names: ["/managed"] }]),
          getContainerStats,
        }),
      },
    }, response);

    expect(getContainerStats).toHaveBeenCalledWith("managed");
    expect(response.json).toHaveBeenCalledWith({
      containers: {
        managed: { cpuPercent: 12.5 },
      },
    });
  });
});

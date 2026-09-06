import { beforeEach, describe, expect, it, vi } from "vitest";

const createServer = vi.fn();
const discoverMounts = vi.fn();
const discoverMountIssues = vi.fn(() => []);
const probeInstallPath = vi.fn();
const probeDataPath = vi.fn();
const readServerIniSettings = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({ createServer, getRoleByName: mockGetRoleByName }));
vi.mock("../services/mountDiscovery.js", () => ({
  discoverMounts,
  discoverMountIssues,
  probeInstallPath,
  probeDataPath,
  readServerIniSettings,
}));

const { default: router } = await import("../routes/discovery.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runCreate(body, user = { role: "admin" }) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/create-from-discovery" &&
      entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const response = createResponse();
  let index = -1;
  const request = { body, user };
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
  return response;
}

async function runDiscover(user = { role: "admin" }) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/discover-mounts" &&
      entry.route.methods.get,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const response = createResponse();
  let index = -1;
  const request = { user };
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
  return response;
}

describe("POST /api/servers/create-from-discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    discoverMounts.mockReturnValue([
      {
        installPath: "/pz-server",
        dataPath: "/zomboid",
        serverNames: ["servertest"],
      },
    ]);
    probeInstallPath.mockReturnValue({ valid: true, serverNames: [] });
    probeDataPath.mockReturnValue({ valid: true, serverNames: ["servertest"] });
    readServerIniSettings.mockReturnValue({
      rconPort: 27015,
      rconPassword: "rcon-secret",
      serverPort: 16261,
      publicName: "Test Server",
    });
    createServer.mockResolvedValue({
      id: "server-id",
      name: "Test Server",
      rconPassword: "rcon-secret",
      adminPassword: "admin-secret",
    });
  });

  it("rejects paths that were not returned by server-side discovery", async () => {
    const response = await runCreate({
      installPath: "/etc",
      dataPath: "/var/lib",
      serverName: "servertest",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects a traversing serverName", async () => {
    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "../../secrets",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("requires an administrator", async () => {
    const response = await runCreate(
      { installPath: "/pz-server", dataPath: "/zomboid" },
      { role: "viewer" },
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("creates from the discovered paths and masks returned credentials", async () => {
    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        installPath: "/pz-server",
        zomboidDataPath: "/zomboid",
        serverName: "servertest",
      }),
    );
    const payload = response.json.mock.calls[0][0];
    expect(payload.server.rconPassword).not.toBe("rcon-secret");
    expect(payload.server.adminPassword).not.toBe("admin-secret");
  });

  it("reports malformed discovered INI settings instead of blaming a missing password", async () => {
    readServerIniSettings.mockReturnValue(null);

    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/valid RCON or game port settings/i),
    });
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects non-string discovery paths with a client error", async () => {
    const response = await runCreate({
      installPath: { path: "/pz-server" },
      dataPath: "/zomboid",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(discoverMounts).not.toHaveBeenCalled();
  });
});

describe("GET /api/servers/discover-mounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires the servers.discover capability", async () => {
    const response = await runDiscover({ role: "viewer" });

    expect(response.status).toHaveBeenCalledWith(403);
    expect(discoverMounts).not.toHaveBeenCalled();
  });

  it("returns discovered mounts to an authorized operator", async () => {
    discoverMounts.mockReturnValue([{ installPath: "/pz-server" }]);

    const response = await runDiscover();

    expect(response.json).toHaveBeenCalledWith({
      mounts: [{ installPath: "/pz-server" }],
      inaccessible: [],
    });
  });

  it("reports permission-denied candidates separately from missing ones", async () => {
    discoverMounts.mockReturnValue([]);
    discoverMountIssues.mockReturnValue([
      { path: "/pz-server", source: "common-mount", reason: "permission-denied" },
    ]);

    const response = await runDiscover();

    expect(response.json).toHaveBeenCalledWith({
      mounts: [],
      inaccessible: [
        { path: "/pz-server", source: "common-mount", reason: "permission-denied" },
      ],
    });
  });
});
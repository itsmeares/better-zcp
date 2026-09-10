import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const controlNames = [
    "getGameServerStatus",
    "getNetworkInterfaces",
    "getManagedServers",
    "getActiveManagedServer",
    "getLifecycleTemplate",
    "getDiscoveredMounts",
    "createServerFromDiscovery",
    "createManagedServer",
    "updateManagedServer",
    "deleteManagedServer",
    "activateManagedServer",
    "activateManagedLifecycleProvider",
    "startServer",
    "stopServer",
    "forceStopServer",
    "restartServer",
    "saveGameWorld",
    "sendServerMessage",
    "startRain",
    "stopRain",
    "startStorm",
    "stopWeather",
    "triggerChopper",
    "triggerGunshot",
    "alarm",
    "removeZombies",
    "releaseSafehouse",
    "getPlayers",
    "kickPlayer",
    "banPlayer",
    "unbanPlayer",
    "addToWhitelist",
    "removeFromWhitelist",
    "teleportPlayer",
    "addPlayerItem",
    "addPlayerXp",
    "addPlayerVehicle",
    "addPlayerVehicleAt",
    "setGodMode",
    "setInvisible",
    "setNoclip",
    "getPlayerVehicles",
    "getPlayerPerks",
    "getPlayerAccessLevels",
    "getSteamIdBans",
    "banSteamId",
    "unbanSteamId",
    "setVoiceBan",
    "addRconUser",
    "addAllToWhitelist",
    "addAllowedSteamId",
    "removeAllowedSteamId",
    "getWhitelist",
  ];
  const control: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of controlNames) {
    const implementation = vi.fn(async (data: unknown) => ({
      handledBy: name,
      data,
    }));
    control[name] = Object.assign(implementation, {
      __executeImplementation: implementation,
    });
  }

  const resource = (name: string) => {
    const implementation = vi.fn(async (data: unknown) => ({
      handledBy: name,
      data,
    }));
    return Object.assign(implementation, {
      __executeImplementation: implementation,
    });
  };
  const resources = {
    getPlayerActivity: resource("getPlayerActivity"),
    getPlayerNotes: resource("getPlayerNotes"),
    getPlayerNote: resource("getPlayerNote"),
    getPlayerStats: resource("getPlayerStats"),
    getPlayerStat: resource("getPlayerStat"),
  };

  return {
    authenticate: vi.fn(),
    getCapabilities: vi.fn(),
    control,
    resources,
  };
});

vi.mock("../services/auth.ts", () => ({
  default: { authenticateApiRequest: mocks.authenticate },
}));
vi.mock("../services/permissions.ts", () => ({
  getCapabilitiesForRole: mocks.getCapabilities,
}));
vi.mock("../../panel-client/src/lib/serverGameControl.ts", () => mocks.control);
vi.mock("../../panel-client/src/lib/serverResourceReads.ts", () => mocks.resources);

const { handleStartApiCompatibilityRequest } = await import(
  "../../panel-client/src/lib/startApiCompatibility.ts"
);

const CONTROL_ROUTES = [
  ["GET", "/api/server/status", "getGameServerStatus"],
  ["GET", "/api/server/network-interfaces", "getNetworkInterfaces"],
  ["GET", "/api/servers", "getManagedServers"],
  ["GET", "/api/servers/active", "getActiveManagedServer"],
  ["GET", "/api/servers/discover-mounts", "getDiscoveredMounts"],
  ["PUT", "/api/servers/server-1", "updateManagedServer"],
  ["DELETE", "/api/servers/server-1", "deleteManagedServer"],
  ["POST", "/api/servers/server-1/activate", "activateManagedServer"],
  ["POST", "/api/servers/server-1/lifecycle-provider", "activateManagedLifecycleProvider"],
  ["GET", "/api/servers/server-1/lifecycle-template", "getLifecycleTemplate"],
  ["POST", "/api/server/start", "startServer"],
  ["POST", "/api/server/stop", "stopServer"],
  ["POST", "/api/server/force-stop", "forceStopServer"],
  ["POST", "/api/server/restart", "restartServer"],
  ["POST", "/api/server/save", "saveGameWorld"],
  ["POST", "/api/server/message", "sendServerMessage"],
  ["POST", "/api/server/weather/start-rain", "startRain"],
  ["POST", "/api/server/weather/stop-rain", "stopRain"],
  ["POST", "/api/server/weather/start-storm", "startStorm"],
  ["POST", "/api/server/weather/stop", "stopWeather"],
  ["POST", "/api/server/events/chopper", "triggerChopper"],
  ["POST", "/api/server/events/gunshot", "triggerGunshot"],
  ["POST", "/api/server/alarm", "alarm"],
  ["POST", "/api/server/removezombies", "removeZombies"],
  ["POST", "/api/server/releasesafehouse", "releaseSafehouse"],
  ["GET", "/api/players", "getPlayers"],
  ["POST", "/api/players/kick", "kickPlayer"],
  ["POST", "/api/players/ban", "banPlayer"],
  ["POST", "/api/players/unban", "unbanPlayer"],
  ["POST", "/api/players/whitelist/add", "addToWhitelist"],
  ["POST", "/api/players/whitelist/remove", "removeFromWhitelist"],
  ["POST", "/api/players/teleport", "teleportPlayer"],
  ["POST", "/api/players/add-item", "addPlayerItem"],
  ["POST", "/api/players/add-xp", "addPlayerXp"],
  ["POST", "/api/players/add-vehicle", "addPlayerVehicle"],
  ["POST", "/api/players/add-vehicle-at", "addPlayerVehicleAt"],
  ["POST", "/api/players/godmode", "setGodMode"],
  ["POST", "/api/players/invisible", "setInvisible"],
  ["POST", "/api/players/noclip", "setNoclip"],
  ["GET", "/api/players/vehicles", "getPlayerVehicles"],
  ["GET", "/api/players/perks", "getPlayerPerks"],
  ["GET", "/api/players/access-levels", "getPlayerAccessLevels"],
  ["GET", "/api/players/steamid-bans", "getSteamIdBans"],
  ["POST", "/api/players/banid", "banSteamId"],
  ["POST", "/api/players/unbanid", "unbanSteamId"],
  ["POST", "/api/players/voiceban", "setVoiceBan"],
  ["POST", "/api/players/adduser", "addRconUser"],
  ["POST", "/api/players/whitelist/addall", "addAllToWhitelist"],
  ["POST", "/api/players/whitelist/steamid/add", "addAllowedSteamId"],
  ["POST", "/api/players/whitelist/steamid/remove", "removeAllowedSteamId"],
  ["GET", "/api/players/whitelist", "getWhitelist"],
];

const RESOURCE_ROUTES = [
  ["GET", "/api/players/activity", "getPlayerActivity"],
  ["GET", "/api/players/notes", "getPlayerNotes"],
  ["GET", "/api/players/notes/Alice", "getPlayerNote"],
  ["GET", "/api/players/stats", "getPlayerStats"],
  ["GET", "/api/players/stats/Alice", "getPlayerStat"],
];

const CREATED_ROUTES = [
  ["POST", "/api/servers/create-from-discovery", "createServerFromDiscovery"],
  ["POST", "/api/servers", "createManagedServer"],
];

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue({
    ok: true,
    user: {
      userId: "user-1",
      username: "admin",
      role: "admin",
      tokenGen: 0,
    },
  });
  mocks.getCapabilities.mockReset().mockResolvedValue([
    "server.control",
    "server.world_events",
    "server.configure",
    "servers.manage",
    "servers.discover",
    "players.view",
    "players.moderate",
    "players.gm_tools",
    "players.endanger_or_impersonate",
  ]);
  for (const fn of [
    ...Object.values(mocks.control),
    ...Object.values(mocks.resources),
  ]) {
    fn.mockClear();
  }
});

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  const headers = new Headers({ authorization: "Bearer test-token" });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`http://panel.test${path}`, init);
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json();
}

describe("Start compatibility server and player routes", () => {
  it.each(CONTROL_ROUTES)(
    "dispatches %s %s to %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path),
      );
      const expectedData =
        method === "PUT"
          ? { id: "server-1", updates: {} }
          : path.includes("/server-1")
            ? { id: "server-1" }
            : {};

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: expectedData,
      });
      expect(mocks.control[functionName]).toHaveBeenCalledWith(
        expectedData,
        expect.objectContaining({ authenticatedUser: expect.any(Object) }),
      );
    },
  );

  it.each(RESOURCE_ROUTES)(
    "dispatches %s %s to %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path),
      );

      expect(response.status).toBe(200);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: path.endsWith("Alice")
          ? { playerName: "Alice" }
          : {},
      });
    },
  );

  it.each(CREATED_ROUTES)(
    "returns 201 for %s %s through %s",
    async (method, path, functionName) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest(method, path, {}),
      );

      expect(response.status).toBe(201);
      expect(await responseBody(response)).toEqual({
        handledBy: functionName,
        data: {},
      });
    },
  );

  it("preserves query and JSON body data for legacy callers", async () => {
    const activity = await handleStartApiCompatibilityRequest(
      makeRequest("GET", "/api/players/activity?player=Alice&limit=25"),
    );
    expect(await responseBody(activity)).toEqual({
      handledBy: "getPlayerActivity",
      data: { player: "Alice", limit: "25" },
    });

    const restart = await handleStartApiCompatibilityRequest(
      makeRequest("POST", "/api/server/restart", { reason: "maintenance" }),
    );
    expect(await responseBody(restart)).toEqual({
      handledBy: "restartServer",
      data: { reason: "maintenance" },
    });

    const update = await handleStartApiCompatibilityRequest(
      makeRequest("PUT", "/api/servers/server-1", { name: "Renamed" }),
    );
    expect(await responseBody(update)).toEqual({
      handledBy: "updateManagedServer",
      data: { id: "server-1", updates: { name: "Renamed" } },
    });

    const lifecycleTemplate = await handleStartApiCompatibilityRequest(
      makeRequest(
        "GET",
        "/api/servers/server-1/lifecycle-template?provider=systemd&serviceUser=pz",
      ),
    );
    expect(await responseBody(lifecycleTemplate)).toEqual({
      handledBy: "getLifecycleTemplate",
      data: { id: "server-1", provider: "systemd", serviceUser: "pz" },
    });
  });

  it("enforces the route capability before invoking the implementation", async () => {
    mocks.getCapabilities.mockResolvedValue([]);

    const response = await handleStartApiCompatibilityRequest(
      makeRequest("POST", "/api/players/kick", { username: "Alice" }),
    );

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({
      error: "Insufficient permissions",
      code: "PERMISSION_DENIED",
    });
    expect(mocks.control.kickPlayer).not.toHaveBeenCalled();
  });

  it.each(["/api/servers/status", "/api/servers/rcon-status"])(
    "leaves the still-Express %s endpoint unmatched for fallback",
    async (path) => {
      const response = await handleStartApiCompatibilityRequest(
        makeRequest("GET", path),
      );

      expect(response.status).toBe(404);
    },
  );
});

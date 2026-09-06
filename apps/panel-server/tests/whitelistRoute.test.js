import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const listWhitelistAccounts = vi.fn();
const logPlayerAction = vi.fn();
const addToWhitelist = vi.fn();
const removeFromWhitelist = vi.fn();
const addAllowedSteamId = vi.fn();
const removeAllowedSteamId = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
}));

vi.mock("../utils/whitelistDb.js", () => ({ listWhitelistAccounts }));
vi.mock("../services/panelBridge.js", () => ({ isRunning: false }));

const { default: router } = await import("../routes/players.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack.at(-1).handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(body = {}, rconService = {}) {
  return {
    body,
    app: { get: () => rconService },
  };
}

describe("whitelist management routes", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    listWhitelistAccounts.mockReset();
    logPlayerAction.mockReset();
    addToWhitelist.mockReset();
    removeFromWhitelist.mockReset();
    addAllowedSteamId.mockReset();
    removeAllowedSteamId.mockReset();
  });

  it("lists non-secret account fields for the active local server", async () => {
    getActiveServer.mockResolvedValue({
      id: "server-1",
      serverName: "DoomerZ",
      zomboidDataPath: "/zomboid",
      isRemote: false,
    });
    listWhitelistAccounts.mockResolvedValue({
      available: true,
      accounts: [{ username: "Alice", role: "user", steamId: "7656119" }],
    });
    const response = createResponse();

    await getHandler("/whitelist", "get")({}, response);

    expect(listWhitelistAccounts).toHaveBeenCalledWith("/zomboid", "DoomerZ");
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      available: true,
      accounts: [{ username: "Alice", role: "user", steamId: "7656119" }],
      server: { id: "server-1", name: "DoomerZ" },
    });
  });

  it("allows the optional Build 42 password when adding an existing player", async () => {
    addToWhitelist.mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/whitelist/add", "post")(
      createRequest({ username: "Alice" }, { addToWhitelist }),
      response,
    );

    expect(addToWhitelist).toHaveBeenCalledWith("Alice", undefined);
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  it("does not report a failed add or removal as success", async () => {
    addToWhitelist.mockResolvedValue({ success: false, error: "RCON failed" });
    removeFromWhitelist.mockResolvedValue({ success: false, error: "RCON failed" });

    const addResponse = createResponse();
    await getHandler("/whitelist/add", "post")(
      createRequest({ username: "Alice", password: "secret" }, { addToWhitelist }),
      addResponse,
    );
    expect(addResponse.status).toHaveBeenCalledWith(400);
    expect(logPlayerAction).not.toHaveBeenCalled();

    const removeResponse = createResponse();
    await getHandler("/whitelist/remove", "post")(
      createRequest({ username: "Alice" }, { removeFromWhitelist }),
      removeResponse,
    );
    expect(removeResponse.status).toHaveBeenCalledWith(400);
  });

  it("validates and manages allowed Steam IDs", async () => {
    addAllowedSteamId.mockResolvedValue({ success: true });
    removeAllowedSteamId.mockResolvedValue({ success: true });

    const invalidResponse = createResponse();
    await getHandler("/whitelist/steamid/add", "post")(
      createRequest({ steamId: "123" }, { addAllowedSteamId }),
      invalidResponse,
    );
    expect(invalidResponse.status).toHaveBeenCalledWith(400);

    const addResponse = createResponse();
    await getHandler("/whitelist/steamid/add", "post")(
      createRequest({ steamId: "76561198000000000" }, { addAllowedSteamId }),
      addResponse,
    );
    expect(addAllowedSteamId).toHaveBeenCalledWith("76561198000000000");
    expect(addResponse.json).toHaveBeenCalledWith({ success: true });

    const removeResponse = createResponse();
    await getHandler("/whitelist/steamid/remove", "post")(
      createRequest({ steamId: "76561198000000000" }, { removeAllowedSteamId }),
      removeResponse,
    );
    expect(removeAllowedSteamId).toHaveBeenCalledWith("76561198000000000");
    expect(removeResponse.json).toHaveBeenCalledWith({ success: true });
  });
});

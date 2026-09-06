import { beforeEach, describe, expect, it, vi } from "vitest";

const logPlayerAction = vi.fn();
const deletePlayerNote = vi.fn();

vi.mock("../database/init.js", () => ({
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote,
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
}));

const { default: router, normalizePlayerLogLimit } = await import(
  "../routes/players.js"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(path, method = "post") {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  // LAST handler, not the first: /add-item now has requirePermission(...)
  // ahead of the real logic this file exercises (players.js's role split),
  // so index 0 would grab the gate instead. Matches the pattern already
  // used by playersBanRecordIntegrity.test.js and whitelistRoute.test.js.
  return layer.route.stack.at(-1).handle;
}

const addItem = vi.fn();

function createRequest(body) {
  return {
    body,
    app: { get: () => ({ addItem }) },
  };
}

async function giveItem(item) {
  const response = createResponse();
  await getHandler("/add-item")(
    createRequest({ username: "Tester", item, count: 1 }),
    response,
  );
  return response;
}

describe("POST /api/players/add-item item ID validation", () => {
  beforeEach(() => {
    addItem.mockReset();
    addItem.mockResolvedValue({ success: true });
    logPlayerAction.mockReset();
  });

  it.each([
    "Base.556Clip",
    "Base.3030Bullets",
    "Base.308Box",
    "Base.3rdGenChevyCKseriesBumperFront0",
    "Base.69fordMustangFenderFrame",
  ])("accepts item IDs whose name starts with a digit (%s)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).toHaveBeenCalledWith("Tester", item, 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  it.each([
    "MarzGuns.M&P_Suppressor",
    "MarzGuns.LRX-7_Laser",
    "Example.Item#Variant+2.0",
  ])("accepts documented punctuation in item IDs (%s)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).toHaveBeenCalledWith("Tester", item, 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  it.each([
    'Base.Axe" ',
    "Base.Axe\\",
    "Base.Axe Base.Nails",
    "NoDotHere",
    "Base.",
    ".Axe",
  ])("rejects malformed or injection-prone IDs (%j)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it("returns 400 for a missing body instead of throwing", async () => {
    const response = createResponse();

    await getHandler("/add-item")(
      createRequest(null),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(addItem).not.toHaveBeenCalled();
  });
});

describe("POST /api/players/add-vehicle-at coordinate validation", () => {
  it("rejects blank coordinate fields instead of converting them to zero", async () => {
    const addVehicleAt = vi.fn();
    const response = createResponse();

    await getHandler("/add-vehicle-at")(
      {
        body: { vehicle: "Base.CarNormal", x: " ", y: "", z: " " },
        app: { get: () => ({ addVehicleAt }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(addVehicleAt).not.toHaveBeenCalled();
  });

  it("passes validated coordinates as numbers", async () => {
    const addVehicleAt = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getHandler("/add-vehicle-at")(
      {
        body: { vehicle: "Base.CarNormal", x: "10.5", y: "20", z: "1" },
        app: { get: () => ({ addVehicleAt }) },
      },
      response,
    );

    expect(addVehicleAt).toHaveBeenCalledWith("Base.CarNormal", 10.5, 20, 1);
  });
});

describe("DELETE /api/players/notes/:playerName", () => {
  it("returns 404 when the note did not exist", async () => {
    deletePlayerNote.mockResolvedValue(false);
    const response = createResponse();

    await getHandler("/notes/:playerName", "delete")(
      { params: { playerName: "MissingPlayer" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "Player note not found",
      // 2026-08-26 bug hunt round 2: players.js adopted the ErrorCode registry.
      code: "PLAYERS_NOTE_NOT_FOUND",
    });
  });
});

describe("player activity limit normalization", () => {
  it.each([
    [undefined, 100],
    ["not-a-number", 100],
    ["-1", 100],
    ["0", 100],
    ["200", 200],
    ["9999", 500],
  ])("normalizes %j to %d rows", (input, expected) => {
    expect(normalizePlayerLogLimit(input)).toBe(expected);
  });
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const logPlayerAction = vi.fn();
const deletePlayerNote = vi.fn();

vi.mock("../database/init.ts", () => ({
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
  "../routes/players.ts"
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

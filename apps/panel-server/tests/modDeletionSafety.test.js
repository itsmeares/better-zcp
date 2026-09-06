import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  getActiveServer,
  getSetting,
  getTrackedMods,
} = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(),
  getTrackedMods: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getSetting,
  getTrackedMods,
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  setSetting: vi.fn(),
  getModPresets: vi.fn(),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(),
  getIgnoredModPairs: vi.fn(),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

vi.mock("../services/steamApiKey.js", () => ({ getSteamApiKey: vi.fn() }));
vi.mock("../services/workshopCollectionSync.js", () => ({
  getCollectionContents: vi.fn(),
  addItemToCollection: vi.fn(),
  removeItemFromCollection: vi.fn(),
  computeDiff: vi.fn(),
  syncSingleChange: vi.fn(),
  fetchPublishedFileTitles: vi.fn(),
}));
vi.mock("../utils/browserCookies.js", () => ({
  listAvailableBrowsers: vi.fn(),
  extractSteamCookies: vi.fn(),
}));

const { default: router, getIniLockCount, withIniLock } = await import("../routes/mods.js");

function getDeleteHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/delete-disk-mod" && entry.route.methods.post,
  );
  return layer.route.stack.at(-1).handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("disk mod deletion safety", () => {
  let root;
  let workshopPath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-mod-delete-"));
    workshopPath = path.join(
      root,
      "steamapps",
      "workshop",
      "content",
      "108600",
      "123",
    );
    fs.mkdirSync(workshopPath, { recursive: true });
    fs.writeFileSync(path.join(workshopPath, "mod.info"), "id=TestMod\n");
    getActiveServer.mockResolvedValue({
      installPath: root,
      serverName: "servertest",
    });
    getSetting.mockResolvedValue(null);
    getTrackedMods.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes completed INI lock chains", async () => {
    const iniPath = path.join(root, "servertest.ini");

    await withIniLock(iniPath, async () => undefined);

    expect(getIniLockCount()).toBe(0);
  });

  it("refuses deletion when the server INI is unavailable", async () => {
    const response = createResponse();

    await getDeleteHandler()(
      { body: { workshopId: "123" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ deletedFromDisk: false }),
    );
    expect(fs.existsSync(workshopPath)).toBe(true);
  });
});
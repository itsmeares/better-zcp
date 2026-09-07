import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.ts", () => ({
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(),
  logServerEvent: vi.fn(),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  addTrackedMod: vi.fn(),
  getActiveServer: vi.fn(async () => null),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(),
}));

const { ModChecker } = await import("../services/modChecker.ts");
const { getTrackedMods } = await import("../database/init.ts");

function steamResponse(details) {
  return {
    ok: true,
    json: async () => ({ response: { publishedfiledetails: details } }),
  };
}

describe("fetchSteamTimestamps: distinguishing removed-upstream from a batch failure", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("tags a confirmed-removed item (EResult 9) distinctly from a found item, instead of dropping it identically to a network failure", async () => {
    global.fetch = vi.fn(async () =>
      steamResponse([
        { publishedfileid: "1111111111", result: 1, time_updated: 5000, title: "Still Here" },
        { publishedfileid: "2222222222", result: 9 },
      ]),
    );

    const checker = new ModChecker();
    const result = await checker.fetchSteamTimestamps([
      "1111111111",
      "2222222222",
    ]);

    expect(result.has("1111111111")).toBe(true);
    expect(result.has("2222222222")).toBe(false);

    expect(checker.lastUnavailableWorkshopIds.get("2222222222")).toEqual({
      resultCode: 9,
      reason: "removed",
    });
  });

  it("tags an unrecognized non-1 result code as 'unknown' with its raw code preserved, not collapsed into 'removed'", async () => {
    global.fetch = vi.fn(async () =>
      steamResponse([{ publishedfileid: "3333333333", result: 2 }]),
    );

    const checker = new ModChecker();
    await checker.fetchSteamTimestamps(["3333333333"]);

    expect(checker.lastUnavailableWorkshopIds.get("3333333333")).toEqual({
      resultCode: 2,
      reason: "unknown",
    });
  });

  it("getStatus() surfaces confirmed-removed workshop IDs for the UI to eventually consume", async () => {
    global.fetch = vi.fn(async () =>
      steamResponse([{ publishedfileid: "2222222222", result: 9 }]),
    );

    const checker = new ModChecker();
    await checker.fetchSteamTimestamps(["2222222222"]);
    getTrackedMods.mockResolvedValueOnce([{ workshop_id: "2222222222" }]);

    const status = await checker.getStatus();
    expect(status.removedWorkshopIds).toEqual(["2222222222"]);
  });

  it("getStatus() surfaces unknown-result-code workshop IDs WITH their raw code, next to (not merged into) removedWorkshopIds", async () => {
    global.fetch = vi.fn(async () =>
      steamResponse([
        { publishedfileid: "2222222222", result: 9 },
        { publishedfileid: "4444444444", result: 15 },
      ]),
    );

    const checker = new ModChecker();
    await checker.fetchSteamTimestamps(["2222222222", "4444444444"]);
    getTrackedMods.mockResolvedValueOnce([
      { workshop_id: "2222222222" },
      { workshop_id: "4444444444" },
    ]);

    const status = await checker.getStatus();
    expect(status.removedWorkshopIds).toEqual(["2222222222"]);
    expect(status.unknownWorkshopIds).toEqual([
      { id: "4444444444", resultCode: 15 },
    ]);
  });

  it("stops surfacing a removed ID after it is no longer tracked, even when the ACF cache remains", async () => {
    global.fetch = vi.fn(async () =>
      steamResponse([{ publishedfileid: "2222222222", result: 9 }]),
    );

    const checker = new ModChecker();
    await checker.fetchSteamTimestamps(["2222222222"]);

    getTrackedMods.mockResolvedValueOnce([{ workshop_id: "2222222222" }]);
    expect((await checker.getStatus()).removedWorkshopIds).toEqual([
      "2222222222",
    ]);

    getTrackedMods.mockResolvedValueOnce([]);
    expect((await checker.getStatus()).removedWorkshopIds).toEqual([]);
  });

  it("does not report a Steam API outage when Steam answers but every queried item is confirmed removed", async () => {
    const acfPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "modchecker-removed-")),
      "appworkshop_108600.acf",
    );
    fs.writeFileSync(
      acfPath,
      `"AppWorkshop"
{
\t"appid"\t\t"108600"
\t"WorkshopItemsInstalled"
\t{
\t\t"2222222222"
\t\t{
\t\t\t"size"\t\t"1234"
\t\t\t"timeupdated"\t\t"1000"
\t\t}
\t}
\t"WorkshopItemDetails"
\t{
\t\t"2222222222"
\t\t{
\t\t\t"timeupdated"\t\t"1000"
\t\t\t"latest_timeupdated"\t\t"1000"
\t\t}
\t}
}
`,
    );

    global.fetch = vi.fn(async () =>
      steamResponse([{ publishedfileid: "2222222222", result: 9 }]),
    );

    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    getTrackedMods.mockResolvedValue([
      { workshop_id: "2222222222", preview_url: null },
    ]);

    await checker.checkForUpdates();
    expect(global.fetch).toHaveBeenCalled();

    expect(checker.steamApiHealthy).toBe(true);
  });
});

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

function writeAcfFixture(acfPath, { workshopId, timeupdated, latestTimeupdated }) {
  fs.mkdirSync(path.dirname(acfPath), { recursive: true });
  fs.writeFileSync(
    acfPath,
    `"AppWorkshop"
{
	"appid"		"108600"
	"WorkshopItemsInstalled"
	{
		"${workshopId}"
		{
			"size"		"1234"
			"timeupdated"		"${timeupdated}"
		}
	}
	"WorkshopItemDetails"
	{
		"${workshopId}"
		{
			"timeupdated"		"${timeupdated}"
			"latest_timeupdated"		"${latestTimeupdated}"
		}
	}
}
`,
  );
}

describe("ModChecker Steam API health tracking", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "modchecker-steam-health-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("starts healthy before any check has run", () => {
    const checker = new ModChecker();
    expect(checker.steamApiHealthy).toBe(true);
  });

  it("flags unhealthy and falls back to ACF-only when Steam returns nothing for a queried mod", async () => {
    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    writeAcfFixture(acfPath, {
      workshopId: "1111111111",
      timeupdated: 1000,
      latestTimeupdated: 2000, // ACF's own cached "latest" says an update exists
    });

    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    checker.fetchSteamTimestamps = vi.fn(async () => new Map());

    const result = await checker.checkForUpdates();

    expect(result.source).toBe("acf-only");
    expect(checker.steamApiHealthy).toBe(false);
    expect(checker.lastSteamApiFailureAt).toBeInstanceOf(Date);

    const status = await checker.getStatus();
    expect(status.steamApiHealthy).toBe(false);
    expect(status.lastSteamApiFailureAt).not.toBeNull();

    expect(result.updated).toBe(true);
  });

  it("stays healthy and reports source: steam when the API responds", async () => {
    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    writeAcfFixture(acfPath, {
      workshopId: "2222222222",
      timeupdated: 1000,
      latestTimeupdated: 1000,
    });

    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    checker.fetchSteamTimestamps = vi.fn(async () =>
      new Map([["2222222222", { time_updated: 1000, title: "Some Mod" }]]),
    );

    const result = await checker.checkForUpdates();

    expect(result.source).toBe("steam");
    expect(checker.steamApiHealthy).toBe(true);
    expect(checker.lastSteamApiFailureAt).toBeNull();

    const status = await checker.getStatus();
    expect(status.steamApiHealthy).toBe(true);
    expect(status.lastSteamApiFailureAt).toBeNull();
  });
});

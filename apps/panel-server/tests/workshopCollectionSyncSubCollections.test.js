import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const settings = new Map();
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-collectionsync-init-"));
let tmpDir = initDir;

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
}));

vi.mock("../utils/paths.ts", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  getCollectionContents,
  addItemToCollection,
  setSteamSessionCredentials,
} = await import("../services/workshopCollectionSync.ts");

describe("workshopCollectionSync — sub-collection children", () => {
  let originalFetch;

  beforeEach(() => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-collectionsync-"));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("getCollectionContents excludes filetype-2 (sub-collection) children from items", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        response: {
          collectiondetails: [
            {
              result: 1,
              title: "Meta Collection",
              children: [
                { publishedfileid: "111", filetype: 0 },
                { publishedfileid: "222", filetype: 2 },
                { publishedfileid: "333" }, // no filetype at all -- must still count as a normal item
              ],
            },
          ],
        },
      }),
    }));

    const result = await getCollectionContents("999999999");

    expect(result.ok).toBe(true);
    expect(result.items.sort()).toEqual(["111", "333"]);
    expect(result.items).not.toContain("222");
  });
});

describe("addItemToCollection — user-facing error text", () => {
  let originalFetch;

  beforeEach(() => {
    settings.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-collectionsync-err-"));
    setSteamSessionCredentials("valid-session-id", "valid-login-secure-token-1234");
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("never leaks the raw protocol body for a fileType:2 (sub-collection) rejection", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: 8, html: "", fileType: 2 }),
    }));

    const result = await addItemToCollection("111111111", "222222222");

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/success=8/);
    expect(result.error).not.toMatch(/"fileType":2/);
    expect(result.error.toLowerCase()).toContain("collection");
  });

  it("gives a human EResult explanation for a plain invalid-parameter rejection (no fileType)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: 8, html: "" }),
    }));

    const result = await addItemToCollection("111111111", "444444444");

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/success=8/);
    expect(result.error.toLowerCase()).toMatch(/invalid parameter|rejected/);
  });
});

describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});

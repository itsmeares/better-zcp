import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// user-report-steam-collection-import-fails-success8-filetype2
//
// Companion to importCollectionSubCollectionFilter.test.js, covering the
// other two places this bug report touched:
//
//  1. getCollectionContents() (the read side used by the Workshop
//     Collection Sync panel's diff) had the exact same missing filetype
//     check as /import-collection -- a sub-collection child would show up
//     as a syncable "item", and any attempt to add it as a Steam
//     collection child would fail identically and permanently.
//
//  2. The raw Steam failure text -- "Steam returned non-success
//     (success=8, body={"success":8,"html":"","fileType":2})" -- used to
//     be handed straight to the user. That is exactly what sent a real,
//     competent user chasing his session cookies for days: the message
//     gave him nothing else to suspect. describeSharedfilesFailure() (via
//     addItemToCollection) must now translate Steam's EResult + fileType
//     into something actionable, and must never leak the raw protocol
//     body into the user-facing `error` string.

const settings = new Map();
// initDir kept as its OWN stable constant, separate from the mutable tmpDir
// below (ENOTEMPTY class, hunt-wave12, 2026-08-29/30): tmpDir gets
// reassigned by every describe block's beforeEach, but logger.js's winston
// singleton resolved logsDir from THIS value, once, at the static import a
// few lines down -- it never re-reads getDataPaths() afterward. No hook in
// this file ever deletes initDir, which is exactly why it used to leak a
// real winston logger's files forever (measured on this machine: 36 such
// directories from this file's prefix, every sampled one containing real
// combined.log/error.log). See the regression test at the bottom of this
// file.
const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-collectionsync-init-"));
let tmpDir = initDir;

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

// ENOTEMPTY class (hunt-wave12, 2026-08-29/30): services/workshopCollectionSync.js
// imports utils/logger.js, so without this the real winston logger resolved
// its logsDir from initDir above (captured at the moment of the static
// import a few lines down) and wrote real log files into it for the
// lifetime of this file's test run. Never the same directory any per-test
// afterEach deletes, so never an ENOTEMPTY risk the way
// modThumbnailResolution.test.js's race was (5d5a9088) -- but a real,
// separate, measured leak this mock closes. Matches the convention already
// established elsewhere in this suite.
vi.mock("../utils/logger.js", () => ({
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
} = await import("../services/workshopCollectionSync.js");

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
    // The old message format leaked the raw body verbatim -- must be gone.
    expect(result.error).not.toMatch(/success=8/);
    expect(result.error).not.toMatch(/"fileType":2/);
    // Must name what's actually wrong, not just fail silently-generic.
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

// ENOTEMPTY class regression (hunt-wave12, 2026-08-29/30): placed last so
// every test above has already run. Before the logger.js mock above, this
// failed -- initDir genuinely contained combined.log/error.log, measured
// directly on this machine. After it, nothing ever writes into initDir at
// all, so this stays green rather than decorative.
describe("ENOTEMPTY class regression: the module-load-time seed directory never receives real logger writes", () => {
  it("initDir (captured at the static import above, never deleted by any hook) contains no *.log files", () => {
    expect(
      fs.readdirSync(initDir).filter((f) => f.endsWith(".log")),
    ).toEqual([]);
  });
});

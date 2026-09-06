import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// user-report-steam-collection-import-fails-success8-filetype2
//
// A real user reported "Import Collection" failing 100% of the time, with
// Steam's own response body naming the cause: {"success":8,"fileType":2}.
// success=8 is Steam's EResult k_EResultInvalidParam; fileType=2 is Steam's
// own enum value for k_EWorkshopFileTypeCollection. Read together: Steam is
// saying "the id you gave me for sharedfiles/addchild IS a collection, not
// a mod" -- a permanent, cookie-independent rejection.
//
// GetCollectionDetails' children[] carries a `filetype` field on every
// entry (see e.g. the CollectionDetailItem model in SteamWebAPI2), and a
// direct child can itself be a sub-collection (filetype 2) rather than an
// ordinary mod -- a real, common curation pattern ("collection of
// collections"). /import-collection used to read every child's
// publishedfileid with no regard for its filetype, so a sub-collection got
// presented to the user as an ordinary importable "mod", tracked, written
// into the server .ini, and later fed into Steam's addchild call as a
// childId -- which Steam will refuse forever, for any account, no matter
// how fresh the session cookies are. This is why the user's collection
// failed 100% of the time and looked exactly like a cookie/auth problem.
//
// FAILS BEFORE THE FIX: the old code has no filetype check at all, so a
// sub-collection child ends up in `mods` (and never in a `subCollectionIds`
// field, which didn't exist).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { default: router } = await import("../routes/mods.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("POST /mods/import-collection — sub-collection children", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("excludes a sub-collection child (filetype 2) from the importable mods list", async () => {
    // Collection "999" has 3 children: two ordinary mods and one
    // sub-collection (a "collection of collections" pattern).
    const fetchMock = vi.fn(async (url) => {
      if (url.includes("GetCollectionDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              collectiondetails: [
                {
                  publishedfileid: "999",
                  result: 1,
                  title: "Meta Collection",
                  children: [
                    { publishedfileid: "111", sortorder: 0, filetype: 0 },
                    { publishedfileid: "222", sortorder: 1, filetype: 2 }, // sub-collection
                    { publishedfileid: "333", sortorder: 2, filetype: 0 },
                  ],
                },
              ],
            },
          }),
        };
      }
      if (url.includes("GetPublishedFileDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              publishedfiledetails: [
                { publishedfileid: "111", result: 1, title: "Mod A", tags: [] },
                { publishedfileid: "333", result: 1, title: "Mod B", tags: [] },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    global.fetch = fetchMock;

    const res = await runRoute("/import-collection", "post", {
      body: { collectionUrl: "999" },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    const importedIds = body.mods.map((m) => m.workshopId);

    // The sub-collection id must never appear as an importable mod.
    expect(importedIds).not.toContain("222");
    expect(importedIds.sort()).toEqual(["111", "333"]);

    // It must be reported back distinctly, not silently dropped.
    expect(body.subCollectionIds).toEqual(["222"]);

    // GetPublishedFileDetails must only have been asked about the 2 real
    // mods -- proving the filter runs before the second Steam call, not
    // just on the display list afterwards.
    const publishedFileCall = fetchMock.mock.calls.find(([url]) =>
      url.includes("GetPublishedFileDetails"),
    );
    const requestedBody = publishedFileCall[1].body;
    const params = new URLSearchParams(requestedBody);
    expect(params.get("itemcount")).toBe("2");
  });

  it("reports subCollectionIds even when every child is a sub-collection", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes("GetCollectionDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              collectiondetails: [
                {
                  publishedfileid: "888",
                  result: 1,
                  children: [
                    { publishedfileid: "444", sortorder: 0, filetype: 2 },
                  ],
                },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url} -- GetPublishedFileDetails should never be called`);
    });
    global.fetch = fetchMock;

    const res = await runRoute("/import-collection", "post", {
      body: { collectionUrl: "888" },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.mods).toEqual([]);
    expect(body.subCollectionIds).toEqual(["444"]);
  });
});

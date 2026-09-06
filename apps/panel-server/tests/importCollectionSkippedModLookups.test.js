import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bug hunt 2026-08-31 (carded low-priority, endorsed as not rising to a
// full finding since nothing here claims completeness -- see
// import-collection-silently-drops-failed-member-lookups): POST
// /import-collection fetches Steam details for every ordinary (non-
// sub-collection) member, then keeps only entries with result === 1. A
// member whose lookup fails -- deleted, made private, or simply omitted
// from Steam's response -- silently disappears from `mods`, with no
// accounting anywhere in the response. The route already gives an
// equivalent notice for skipped SUB-collections (`subCollectionIds`); this
// fix adds the same accounting for individually-failed mod lookups
// (`skippedModIds`), so a caller can tell "3 were dropped" apart from "the
// collection only ever had 47".

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

describe("POST /mods/import-collection -- skippedModIds accounts for failed member lookups", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports a mod that Steam returned with result !== 1 (e.g. deleted/private) in skippedModIds, not in mods", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes("GetCollectionDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              collectiondetails: [
                {
                  publishedfileid: "777",
                  result: 1,
                  children: [
                    { publishedfileid: "111", sortorder: 0, filetype: 0 },
                    { publishedfileid: "222", sortorder: 1, filetype: 0 },
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
                // 222: Steam still returns an entry but result !== 1 (deleted/private).
                { publishedfileid: "222", result: 9 },
                { publishedfileid: "333", result: 1, title: "Mod C", tags: [] },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    global.fetch = fetchMock;

    const res = await runRoute("/import-collection", "post", {
      body: { collectionUrl: "777" },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();

    expect(body.mods.map((m) => m.workshopId).sort()).toEqual(["111", "333"]);
    expect(body.skippedModIds).toEqual(["222"]);
    expect(body.totalMods).toBe(2);
  });

  it("reports a mod Steam omitted from the response entirely in skippedModIds", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes("GetCollectionDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              collectiondetails: [
                {
                  publishedfileid: "555",
                  result: 1,
                  children: [
                    { publishedfileid: "111", sortorder: 0, filetype: 0 },
                    { publishedfileid: "444", sortorder: 1, filetype: 0 },
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
          // Steam simply doesn't include an entry for 444 at all.
          json: async () => ({
            response: {
              publishedfiledetails: [
                { publishedfileid: "111", result: 1, title: "Mod A", tags: [] },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    global.fetch = fetchMock;

    const res = await runRoute("/import-collection", "post", {
      body: { collectionUrl: "555" },
    });

    const body = res.getBody();
    expect(body.mods.map((m) => m.workshopId)).toEqual(["111"]);
    expect(body.skippedModIds).toEqual(["444"]);
  });

  it("reports an empty skippedModIds when every requested mod resolves (unchanged behavior)", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes("GetCollectionDetails")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              collectiondetails: [
                {
                  publishedfileid: "666",
                  result: 1,
                  children: [{ publishedfileid: "111", sortorder: 0, filetype: 0 }],
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
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    global.fetch = fetchMock;

    const res = await runRoute("/import-collection", "post", {
      body: { collectionUrl: "666" },
    });

    expect(res.getBody().skippedModIds).toEqual([]);
  });
});

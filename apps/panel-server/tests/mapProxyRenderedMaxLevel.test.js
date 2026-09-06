import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GH#109 / conv-gh109-worldmap-black: a real user reported the world map's
// terrain turning solid black above 137% zoom while player/vehicle dots
// kept rendering. Root cause: mapProxy.js computed maxLevel as
// Math.ceil(log2(max(width, height))) -- the depth a FULL Deep Zoom pyramid
// would need for the image's dimensions -- and handed it to the client as
// "the deepest level you may request", when it's really just arithmetic on
// the image size, not evidence the tile host rendered that deep. Level 21
// at 1024px tiles is ~563,000 tiles for one floor, so real coverage falls
// well short and most of the map 404s past some real (much shallower)
// level. hasTileCoverage() already independently needed maxLevel-6 to find
// ANY rendered tile at its "inhabited area" probe points before picking a
// directory at all -- the tell that someone had already half-discovered
// this and worked around it locally without carrying the fix to the
// renderer, which still trusted maxLevel.
//
// discoverRenderedMaxLevel() binary-searches the [maxLevel-6, maxLevel] gap
// (same probe points as hasTileCoverage) for the deepest level that still
// resolves, and /api/map/resolve now reports that as renderedMaxLevel
// alongside the theoretical maxLevel -- WorldMap.tsx clamps its requested
// level to renderedMaxLevel instead.

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

function curlResult(status, body) {
  return { stdout: `${body}\n__CURL_HTTP_STATUS__:${status}`, stderr: "" };
}

function mockCurlRouter(impl) {
  mockExecFile.mockImplementation((_file, args, _options, callback) => {
    const url = args[args.length - 1];
    try {
      callback(null, impl(url));
    } catch (err) {
      callback(err);
    }
  });
}

const GEOMETRY_42_20_0 = { tileSize: 2048, width: 2318656, height: 1019040 };
// Math.ceil(log2(2318656)) = 22, confirmed independently below.

function dziXml(g) {
  return `<?xml version="1.0"?><Image TileSize="${g.tileSize}" Overlap="0" Format="jpg"><Size Width="${g.width}" Height="${g.height}"/></Image>`;
}

function mapInfoJson() {
  return JSON.stringify({ x0: 1040384, y0: -139296, sqr: 128, skip: 0 });
}

async function freshModule() {
  vi.resetModules();
  return await import("../routes/mapProxy.js");
}

function findRoute(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function callResolve(router) {
  const handler = findRoute(router, "/resolve", "get");
  const res = { set: vi.fn(), json: vi.fn() };
  await handler({}, res);
  expect(res.json).toHaveBeenCalledTimes(1);
  return res.json.mock.calls[0][0];
}

// Extracts the numeric tile level from a probe URL of the shape
// .../base/layer0_files/<level>/<col>_<row>.jpg
function levelFromProbeUrl(url) {
  const m = String(url).match(/layer0_files\/(\d+)\//);
  return m ? Number(m[1]) : null;
}

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

function mockCurlForB42_20_0() {
  mockCurlRouter((url) => {
    if (url.endsWith("/api/builds/default")) {
      return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
    }
    if (url.includes("/base/layer0.dzi")) return curlResult(200, dziXml(GEOMETRY_42_20_0));
    if (url.includes("/base/map_info.json")) return curlResult(200, mapInfoJson());
    throw new Error(`unexpected curl URL in test: ${url}`);
  });
}

describe("discoverRenderedMaxLevel (via /api/map/resolve)", () => {
  it("reports the real deepest covered level, not the theoretical maxLevel, when coverage stops short", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    // maxLevel is 22 (ceil(log2(2318656))); simulate real coverage stopping
    // at level 19 -- everything <=19 resolves, 20/21/22 all 404. Floor for
    // the search is maxLevel-6=16 (hasTileCoverage's own gate), so this
    // exercises the binary search actually finding a level strictly between
    // the known-good floor and the theoretical ceiling.
    global.fetch = vi.fn(async (url) => {
      const level = levelFromProbeUrl(url);
      return { ok: level !== null && level <= 19 };
    });
    try {
      const { default: router } = await freshModule();
      const body = await callResolve(router);
      expect(body.maxLevel).toBe(22);
      expect(body.renderedMaxLevel).toBe(19);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("reports maxLevel itself when the full theoretical depth genuinely resolves", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true }));
    try {
      const { default: router } = await freshModule();
      const body = await callResolve(router);
      expect(body.renderedMaxLevel).toBe(body.maxLevel);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("reports exactly the known-safe floor (maxLevel-6) when nothing past it resolves", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url) => {
      const level = levelFromProbeUrl(url);
      return { ok: level !== null && level <= 16 }; // maxLevel(22) - 6 = 16
    });
    try {
      const { default: router } = await freshModule();
      const body = await callResolve(router);
      expect(body.renderedMaxLevel).toBe(16);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("costs only a handful of HEAD requests, not one per level in the gap", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    let headCalls = 0;
    global.fetch = vi.fn(async (url) => {
      headCalls++;
      const level = levelFromProbeUrl(url);
      return { ok: level !== null && level <= 19 };
    });
    try {
      const { default: router } = await freshModule();
      await callResolve(router);
      // hasTileCoverage's own probe (>=1) + binary search over a gap of 6
      // (ceil(log2(6)) ~= 3 rounds) * up to 3 probe fractions each -- well
      // under a linear scan of the whole [16,22] gap (which would be able
      // to reach 21+ requests).
      expect(headCalls).toBeLessThan(15);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// GH#109 follow-up (god's review of 3d09d94): when discovery cannot even
// run (curl entirely unavailable, the same failure mode
// mapProxyB42Discovery.test.js already covers for getB42Dir/directory
// selection), the served geometry falls back to B42_GEOMETRY_FALLBACK.
// renderedMaxLevel there must preserve the known fallback build's verified
// full DZI ceiling, so a temporary discovery outage does not silently remove
// its higher-resolution tiles from the client.
describe("discoverRenderedMaxLevel: fails CLOSED when discovery cannot run at all", () => {
  it("keeps the verified fallback ceiling when curl itself is unavailable", async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const err = new Error("spawn curl ENOENT");
      err.code = "ENOENT";
      callback(err);
    });

    const { default: router } = await freshModule();
    const body = await callResolve(router);

    expect(body.maxLevel).toBe(22); // B42_GEOMETRY_FALLBACK
    expect(body.renderedMaxLevel).toBe(22); // verified B42_DIR_FALLBACK ceiling
    expect(body.renderedMaxLevel).toBe(body.maxLevel);
  });
});

describe("GH#109 arithmetic confirmation: the reported 137%/138% zoom boundary is a real DZI level step", () => {
  // Mirrors WorldMap.tsx's own readout formula (scale/defaultScale*100) and
  // level formula (round(maxLevel + log2(s))), independently, so a future
  // change to either constant re-proves the boundary instead of silently
  // drifting from the number this test (and the bug report) depend on.
  function levelStepPercent(maxLevel, defaultScale, fromLevel) {
    const s = 2 ** (fromLevel + 0.5 - maxLevel);
    return (s / defaultScale) * 100;
  }

  it("B42 (maxLevel 21, defaultScale 0.002): the 12->13 level step lands at ~138%, matching the user's reported 137% cutoff", () => {
    const percent = levelStepPercent(21, 0.002, 12);
    expect(percent).toBeCloseTo(138.11, 1);
  });

  it("B41 (maxLevel 22, defaultScale 0.001): the same step lands at ~138% too", () => {
    const percent = levelStepPercent(22, 0.001, 12);
    expect(percent).toBeCloseTo(138.11, 1);
  });
});

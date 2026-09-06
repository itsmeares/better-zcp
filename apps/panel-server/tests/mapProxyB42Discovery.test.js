import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression/coverage for getB42Map()'s dynamic B42 build discovery
// (conv-mapbuild): the endpoint it used to call (build_list.json) is dead,
// and every JSON/XML descriptor path this needs is behind a Cloudflare
// challenge for Node's own TLS stack (fetch AND https alike) that curl gets
// through far more reliably -- see the header comment in
// apps/panel-server/routes/mapProxy.js. This proves BOTH branches by forcing them, per
// god's dispatch: (a) discovery succeeds and resolves the build pzmap.org
// itself flags as default via /api/builds/default, including the reversed
// (newest-first) full-list walk when that specific build isn't rendered
// yet; (b) discovery fails outright and the panel still serves the
// hardcoded fallback AND reports it honestly via getB42ResolutionStatus().
// Two source states only: 'dynamic' | 'fallback' -- a client-resolve tier
// was proposed, investigated, and explicitly rejected (see conv-mapbuild)
// because its own success rate couldn't be verified through Cloudflare from
// any browser, and shipping unverifiable fallback machinery would repeat
// the exact "looks healthy, isn't" shape this feature exists to fix.

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

function curlResult(status, body) {
  return { stdout: `${body}\n__CURL_HTTP_STATUS__:${status}`, stderr: "" };
}

// Maps a URL to a canned curl response. `impl` receives the URL (the last
// non-flag arg before "--") and returns a curlResult(...), or throws an
// Error (simulating curl itself failing / ENOENT) to reject the call.
function mockCurlRouter(impl) {
  mockExecFile.mockImplementation((_file, args, _options, callback) => {
    const url = args[args.length - 1];
    try {
      const result = impl(url);
      callback(null, result);
    } catch (err) {
      callback(err);
    }
  });
}

const GEOMETRY_42_20_0 = {
  tileSize: 2048,
  width: 2318656,
  height: 1019040,
  maxLevel: 22,
};

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

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("getB42Map() discovery: forcing success", () => {
  it("resolves the default-flagged build in one round trip when it's fully rendered", async () => {
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        return curlResult(200, JSON.stringify({ id: 10, directory: "42.20.0", default: true }));
      }
      if (url.includes("/base/layer0.dzi")) {
        return curlResult(200, dziXml(GEOMETRY_42_20_0));
      }
      if (url.includes("/base/map_info.json")) {
        return curlResult(200, mapInfoJson());
      }
      throw new Error(`unexpected curl URL in test: ${url}`);
    });

    const { getB42Dir, getB42ResolutionStatus } = await freshModule();
    // hasTileCoverage() uses plain fetch (tile bytes aren't behind the
    // challenge) -- stub global fetch so the HEAD coverage probe succeeds.
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true }));
    try {
      const dir = await getB42Dir();
      expect(dir).toBe("42.20.0");
      expect(getB42ResolutionStatus()).toEqual({
        source: "dynamic",
        directory: "42.20.0",
        reason: null,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls through to the reversed full-list walk when the default build has no rendered coverage yet, and picks the newest usable one -- proving the ordering fix", async () => {
    // api/builds is oldest-first in real life; a NEWER build than the
    // (unrendered) default sits at the END of a realistic list, and a
    // forward walk would never reach it. This list includes one such case:
    // 42.21.0 (newer than the flagged default, appended last) should win
    // over 42.19.0 (older, appears first).
    const buildList = [
      { directory: "41.78.16", default: false },
      { directory: "42.19.0", default: false },
      { directory: "42.21.0", default: false },
    ];
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        // Flagged default (42.20.0) isn't even in the list below -- e.g.
        // listed but pulled -- so this candidate is tried and fails.
        return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
      }
      if (url.endsWith("/api/builds")) {
        return curlResult(200, JSON.stringify(buildList));
      }
      if (url.includes("42.20.0/base/layer0.dzi")) {
        // The default build: geometry reads fine, but has no coverage --
        // simulated via global.fetch below returning ok:false for it only.
        return curlResult(200, dziXml(GEOMETRY_42_20_0));
      }
      if (url.includes("42.21.0/base/layer0.dzi")) {
        return curlResult(200, dziXml(GEOMETRY_42_20_0));
      }
      if (url.includes("/base/map_info.json")) {
        return curlResult(200, mapInfoJson());
      }
      // 41.78.16 / 42.19.0 geometry: never reached if the reverse walk is
      // correct, since 42.21.0 (tried first in a newest-first walk) succeeds.
      throw new Error(`unexpected curl URL in test (would prove the ordering bug): ${url}`);
    });

    const { getB42Dir, getB42ResolutionStatus } = await freshModule();
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url) => ({ ok: String(url).includes("42.21.0") }));
    try {
      const dir = await getB42Dir();
      expect(dir).toBe("42.21.0");
      expect(getB42ResolutionStatus().source).toBe("dynamic");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("getB42Map() discovery: forcing failure", () => {
  it("falls back to the hardcoded build and reports it honestly when curl itself is unavailable", async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const err = new Error("spawn curl ENOENT");
      err.code = "ENOENT";
      callback(err);
    });

    const { getB42Dir, getB42ResolutionStatus } = await freshModule();
    const dir = await getB42Dir();
    expect(dir).toBe("42.20.0"); // B42_DIR_FALLBACK

    const status = getB42ResolutionStatus();
    expect(status.source).toBe("fallback");
    expect(status.directory).toBe("42.20.0");
    expect(status.reason).toMatch(/curl is not available/i);
  });

  it("falls back when upstream is reachable but every candidate is unusable", async () => {
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        return curlResult(404, "");
      }
      if (url.endsWith("/api/builds")) {
        return curlResult(200, JSON.stringify([{ directory: "41.78.16" }]));
      }
      throw new Error(`unexpected curl URL: ${url}`);
    });

    const { getB42Dir, getB42ResolutionStatus } = await freshModule();
    const dir = await getB42Dir();
    expect(dir).toBe("42.20.0");
    expect(getB42ResolutionStatus().source).toBe("fallback");
  });
});

// This contract has broken twice in one night, in opposite directions --
// once with the producer (here) emitting `build` while the consumer
// (debug.js) read `directory`, once the other way around while the
// contract itself was being corrected mid-flight. Both were invisible to
// worldMapBuildDetectStates.test.js because that file mocks
// getB42ResolutionStatus() entirely -- it asserts on whatever shape the
// mock is TOLD to return, so it can never notice the real producer
// drifting from what debug.js actually reads (resolution.source,
// .directory, .reason -- see apps/panel-server/routes/debug.js's worldmap.tiles.buildDetect
// check). This test calls the REAL function, on the producer side, so a
// future rename here fails immediately instead of silently reintroducing
// "Build undefined".
describe("getB42ResolutionStatus() contract shape", () => {
  it("returns exactly {source, directory, reason} -- no more, no less, no renamed keys", async () => {
    const { getB42ResolutionStatus } = await freshModule();
    // Before any resolution attempt, source/reason are legitimately null --
    // this test is about the KEY SHAPE debug.js reads, not resolution
    // state, so it doesn't trigger getB42Map() at all.
    const status = getB42ResolutionStatus();
    expect(Object.keys(status).sort()).toEqual(["directory", "reason", "source"]);
    expect(typeof status.directory).toBe("string"); // always B42_DIR_FALLBACK or a resolved build, never null
  });
});

// Regression for conv-mapcleanup-perf: on a cold cache, EVERY concurrent
// tile request called getB42Map()/getB42TopFormat() independently, each one
// re-running the full curl-based discovery instead of sharing the one
// already in flight. Measured against a real isolated server: 80 concurrent
// cold requests to GET /toptiles took 7.3s uncoalesced, 1.4s after adding
// in-flight-promise sharing (matching a single request's own cold cost) --
// this pins that behaviour so it can't silently regress back to N redundant
// curl spawns per page load.
describe("getB42Map() / getB42TopFormat(): concurrent-call coalescing", () => {
  it("getB42Dir(): N concurrent cold calls trigger the discovery curl calls only once, not N times", async () => {
    let defaultCalls = 0;
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        defaultCalls++;
        return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
      }
      if (url.includes("/base/layer0.dzi")) return curlResult(200, dziXml(GEOMETRY_42_20_0));
      if (url.includes("/base/map_info.json")) return curlResult(200, mapInfoJson());
      throw new Error(`unexpected curl URL in test: ${url}`);
    });

    const { getB42Dir } = await freshModule();
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true }));
    try {
      const N = 20;
      const results = await Promise.all(Array.from({ length: N }, () => getB42Dir()));
      expect(results).toEqual(Array(N).fill("42.20.0"));
      // One shared resolution, not one per caller -- the whole point of the fix.
      expect(defaultCalls).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("getB42TopFormat(): N concurrent cold calls for the same directory curl the descriptor only once", async () => {
    let descriptorCalls = 0;
    mockCurlRouter((url) => {
      if (url.endsWith("/base_top/layer0.dzi")) {
        descriptorCalls++;
        return curlResult(200, '<?xml version="1.0"?><Image Format="webp"/>');
      }
      throw new Error(`unexpected curl URL in test: ${url}`);
    });

    const { getB42TopFormat } = await freshModule();
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => getB42TopFormat("42.20.0")),
    );
    expect(results).toEqual(Array(N).fill("webp"));
    expect(descriptorCalls).toBe(1);
  });

  it("getB42TopFormat(): a later call after the first resolves reuses the cache, no new curl call", async () => {
    let descriptorCalls = 0;
    mockCurlRouter((url) => {
      if (url.endsWith("/base_top/layer0.dzi")) {
        descriptorCalls++;
        return curlResult(200, '<?xml version="1.0"?><Image Format="jpg"/>');
      }
      throw new Error(`unexpected curl URL in test: ${url}`);
    });

    const { getB42TopFormat } = await freshModule();
    const first = await getB42TopFormat("42.20.0");
    const second = await getB42TopFormat("42.20.0");
    expect(first).toBe("jpg");
    expect(second).toBe("jpg");
    expect(descriptorCalls).toBe(1);
  });
});

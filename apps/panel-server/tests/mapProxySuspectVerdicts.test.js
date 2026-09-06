import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// hunt-wave10-2026-08-29: verdicts for the remaining 4 suspects on god's
// mapProxy.js card (suspect 4 -- tile Cache-Control staleness -- was REAL
// and is fixed + break-verified separately in
// mapProxyTileBrowserCacheStaleness.test.js). All four verdicts here are
// DEAD, each proven against the real route handlers (not just read), per
// "prove it, do not read it."
//
// Suspect 1 (path traversal / containment): DEAD. All three tile routes
// validate :level and :floor via parseBoundedInteger (strict digit regex,
// range-bounded, returns null -> 400 for anything else) and :tile via a
// fully-anchored ^...$ regex requiring the ENTIRE decoded param to be
// digits/underscore/extension -- no `/`, `..`, or null byte can survive
// that regex, encoded-slash bypass included (Express decodes %2f into a
// literal `/` in req.params BEFORE the handler runs, but the regex still
// rejects the decoded result). The upstream-controlled `dir` value
// (getB42Dir()) is separately constrained by isB42PlusCandidate's
// ^4[2-9][\w.\-]*$, which also forbids `/`, so it cannot be used to escape
// TILE_CACHE_DIR via path.join either.
//
// Suspect 2 (B41/B42 split asymmetry): DEAD as a defect. /b41tiles hardcodes
// build "41.78.16" and layer0 (no :floor handling) while /tiles resolves
// dir dynamically and accepts a floor query -- but this is a real,
// understood asymmetry: B41 has no multi-floor tile set at all, and
// WorldMap.tsx (client, read-only for this card) explicitly forces floor
// back to 0 and hides the floor selector whenever the active build is B41
// (see the "B41 has no multi-floor tiles" comment ~line 820). The backend
// asymmetry matches a client-side asymmetry the client already knows about
// and accounts for -- not a departed sibling, a correctly-modeled one.
//
// Suspect 3 (missing tile handling): DEAD. serveTile() passes a genuine
// upstream 404 straight through with X-Tile-Cache: miss and no log entry
// (quiet -- sparse coverage is normal, not an error), while a 5xx or a
// thrown network error is mapped to 502 and logged at debug (not error)
// level, so a dead upstream still can't flood the log. WorldMap.tsx
// (client) already has a matching, deliberate split: a bare 404 is tracked
// as an 'empty' tile (renders blank, never counts toward the failure
// banner) while anything else counts toward it, keyed off exactly the
// distinction this file's status-code handling makes.
//
// Suspect 5 (path/secret leak via /resolve and /vehicles): DEAD. /resolve's
// response body is built entirely from hardcoded remote hostnames, the
// resolved (regex-constrained) B42 build directory string, and plain
// numeric geometry -- no local filesystem path ever enters it. /vehicles'
// response is `{ vehicles: listPersistedVehicles(savePath) }`, and
// listPersistedVehicles (apps/panel-server/utils/vehiclesDb.js) selects only
// `id, x, y` from the sqlite table -- savePath itself (which DOES embed the
// operator's local zomboidDataPath and server/save name) is used only to
// build a query, never returned. Both the not-found/error paths in
// /vehicles quietly fall back to `{ vehicles: [] }`, so a filesystem error
// message never reaches the client either.

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const mockGetActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => mockGetActiveServer(...args),
}));

const mockListPersistedVehicles = vi.fn();
vi.mock("../utils/vehiclesDb.js", () => ({
  listPersistedVehicles: (...args) => mockListPersistedVehicles(...args),
}));

// createLogger() returns a fresh winston child logger object per call (see
// apps/panel-server/utils/logger.js), so spying on a separately-obtained instance
// never observes calls made on mapProxy.js's own module-level `log` --
// mocking the whole module, closed over these same fns across
// vi.resetModules(), is the only way to reliably assert "was log.error
// ever called" against the REAL call site.
const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();
const mockLogDebug = vi.fn();
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    error: (...args) => mockLogError(...args),
    warn: (...args) => mockLogWarn(...args),
    info: (...args) => mockLogInfo(...args),
    debug: (...args) => mockLogDebug(...args),
  }),
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
function dziXml(g) {
  return `<?xml version="1.0"?><Image TileSize="${g.tileSize}" Overlap="0" Format="jpg"><Size Width="${g.width}" Height="${g.height}"/></Image>`;
}
function mapInfoJson() {
  return JSON.stringify({ x0: 1040384, y0: -139296, sqr: 128, skip: 0 });
}
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

function findRoute(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const headers = {};
  let statusCode = 200;
  let sentBody = null;
  let jsonBody = null;
  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    get sentBody() {
      return sentBody;
    },
    get jsonBody() {
      return jsonBody;
    },
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    end() {
      return this;
    },
    send(body) {
      sentBody = body;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
}

async function freshModule() {
  vi.resetModules();
  return await import("../routes/mapProxy.js");
}

beforeEach(() => {
  mockExecFile.mockReset();
  mockGetActiveServer.mockReset();
  mockListPersistedVehicles.mockReset();
  mockLogError.mockReset();
  mockLogWarn.mockReset();
  mockLogInfo.mockReset();
  mockLogDebug.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("suspect 1 (DEAD): path traversal / containment on tile params", () => {
  const TRAVERSAL_TILE_PAYLOADS = [
    "../../../etc/passwd.jpg",
    "..%2f..%2f..%2fetc%2fpasswd.jpg", // pre-decoded form, as req.params would already contain after Express's own decode
    "..\\..\\..\\windows\\win.ini.jpg",
    "5_5.jpg\u0000.png", // embedded null byte
    "/etc/passwd.jpg",
    "5_5.jpg/../../../etc/passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd.jpg",
    "a".repeat(5000) + "_1.jpg", // very long segment
  ];

  it.each(TRAVERSAL_TILE_PAYLOADS)(
    "/tiles rejects tile=%j with 400, never reaching the filesystem or upstream",
    async (payload) => {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "5", tile: payload }, query: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(mockExecFile).not.toHaveBeenCalled();
    },
  );

  it.each(TRAVERSAL_TILE_PAYLOADS)(
    "/toptiles rejects tile=%j with 400",
    async (payload) => {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/toptiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "5", tile: payload }, query: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(mockExecFile).not.toHaveBeenCalled();
    },
  );

  it.each(TRAVERSAL_TILE_PAYLOADS)(
    "/b41tiles rejects tile=%j with 400",
    async (payload) => {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "5", tile: payload }, query: {} }, res);
      expect(res.statusCode).toBe(400);
    },
  );

  const TRAVERSAL_LEVEL_PAYLOADS = ["../../etc", "5;rm -rf", "-1", "999", "5.5", "0x5"];
  it.each(TRAVERSAL_LEVEL_PAYLOADS)(
    "/tiles rejects level=%j with 400",
    async (payload) => {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: payload, tile: "5_5.jpg" }, query: {} }, res);
      expect(res.statusCode).toBe(400);
    },
  );

  it("/tiles rejects an out-of-range floor query (path segment interpolated into the upstream URL) with 400", async () => {
    const { default: router } = await freshModule();
    const handler = findRoute(router, "/tiles/:level/:tile", "get");
    const res = makeRes();
    await handler(
      { params: { level: "5", tile: "5_5.jpg" }, query: { floor: "../../etc/passwd" } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("a directory value from upstream that fails isB42PlusCandidate's regex is never adopted, so it can never reach path.join/fetch for a tile", async () => {
    // Simulates a compromised/misbehaving upstream trying to hand back a
    // traversal-shaped directory via /api/builds/default.
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        return curlResult(200, JSON.stringify({ directory: "../../../etc", default: true }));
      }
      if (url.endsWith("/api/builds")) {
        return curlResult(200, JSON.stringify([]));
      }
      throw new Error(`unexpected curl URL in test (would prove the traversal bug): ${url}`);
    });
    const { getB42Dir, getB42ResolutionStatus } = await freshModule();
    const dir = await getB42Dir();
    // Falls back to the hardcoded, known-safe directory instead of ever
    // adopting the malicious-shaped one.
    expect(dir).toBe("42.20.0");
    expect(getB42ResolutionStatus().source).toBe("fallback");
  });
});

describe("suspect 2 (DEAD as a defect): B41/B42 floor asymmetry is intentional and matches the client", () => {
  it("/b41tiles ignores a floor query entirely rather than erroring or misrouting -- confirms the asymmetry is a deliberate omission, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
    }));
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      await handler(
        { params: { level: "5", tile: "5_5.jpg" }, query: { floor: "3" } },
        res,
      );
      expect(res.statusCode).toBe(200);
      // The URL fetched must still be the fixed 41.78.16/layer0 path --
      // floor=3 must not have been interpolated in anywhere.
      const fetchedUrl = String(global.fetch.mock.calls[0][0]);
      expect(fetchedUrl).toBe(
        "https://tiles.pzmap.org/41.78.16/base/layer0_files/5/5_5.jpg",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("/tiles (B42) DOES honour a floor query, the capability /b41tiles deliberately lacks", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, init) => {
      if ((init?.method || "GET") === "HEAD") return { ok: true };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
      };
    });
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/tiles/:level/:tile", "get");
      const res = makeRes();
      await handler(
        { params: { level: "5", tile: "5_5.jpg" }, query: { floor: "3" } },
        res,
      );
      expect(res.statusCode).toBe(200);
      const calls = global.fetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/layer3_files/5/5_5.jpg"))).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("suspect 3 (DEAD): a genuinely missing tile is a quiet 404, not a 500, and is distinguished from a real upstream failure", () => {
  it("upstream 404 (sparse/edge tile) passes through as 404 with X-Tile-Cache: miss, never 500", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "20", tile: "999_999.jpg" }, query: {} }, res);
      expect(res.statusCode).toBe(404);
      expect(res.headers["X-Tile-Cache"]).toBe("miss");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("a genuine upstream 5xx is mapped to 502 (never passed through as-is, never a bare 500)", async () => {
    const originalFetch = global.fetch;
    // Circuit breaker requires 8 consecutive failures to open; a single 503
    // (with one internal retry, both failing) stays well under that, so
    // this exercises the per-request mapping, not the breaker.
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      // Distinct coordinates from every other test in this file -- the
      // per-file dataDir's on-disk tile cache persists across tests, and a
      // colliding coordinate here would let a PRIOR test's successful fetch
      // serve this one from disk before this mock ever runs.
      await handler({ params: { level: "9", tile: "9_1.jpg" }, query: {} }, res);
      expect(res.statusCode).toBe(502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("a 404 never calls log.error/log.warn (would flood the log for the normal, sparse-map case)", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
      await handler({ params: { level: "9", tile: "9_2.jpg" }, query: {} }, res);
      expect(res.statusCode).toBe(404);
      expect(mockLogError).not.toHaveBeenCalled();
      expect(mockLogWarn).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("suspect 5 (DEAD): /resolve and /vehicles never leak local filesystem paths or save names", () => {
  it("/resolve's body contains no local path (no drive letter, no /home, no /data segment)", async () => {
    mockCurlForB42_20_0();
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true }));
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/resolve", "get");
      const res = makeRes();
      await handler({}, res);
      const serialized = JSON.stringify(res.jsonBody);
      expect(serialized).not.toMatch(/[A-Za-z]:\\|\/home\/|\/data\/|zomboidDataPath|Saves[\\/]Multiplayer/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("/vehicles never includes the save path or server name -- only {id, x, y} per vehicle", async () => {
    mockGetActiveServer.mockResolvedValue({
      isRemote: false,
      zomboidDataPath: "C:\\Users\\SomeOperator\\Zomboid",
      serverName: "servertest",
    });
    mockListPersistedVehicles.mockResolvedValue([
      { id: 1, x: 100, y: 200 },
      { id: 2, x: 300, y: 400 },
    ]);
    const { default: router } = await freshModule();
    const handler = findRoute(router, "/vehicles", "get");
    const res = makeRes();
    await handler({}, res);
    expect(res.jsonBody).toEqual({
      vehicles: [
        { id: 1, x: 100, y: 200 },
        { id: 2, x: 300, y: 400 },
      ],
    });
    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized).not.toMatch(/SomeOperator|Zomboid|servertest|Saves|Multiplayer/i);
    // Confirms the sensitive path DID reach the internal lookup call (so
    // this isn't a false-DEAD from the mock just not exercising it) --
    // it's just never echoed back to the client. Deliberately NOT built by
    // path.join()-ing the same segments here: that would share a code path
    // with the thing under test and could only ever confirm that path's own
    // assumptions. Instead assert on substrings only -- the route's actual
    // join separator is `path.join`, which is path.posix.join on Linux and
    // path.win32.join on Windows; a Windows-shaped fixture prefix joined via
    // path.posix.join produces a MIXED-separator string that a hardcoded
    // backslash literal can never match on Linux (caught by god's gate on
    // 00bfa2b7 -- this is the fix). Checking for the distinguishing
    // substrings is separator-agnostic and still rules out the false-DEAD.
    expect(mockListPersistedVehicles).toHaveBeenCalledTimes(1);
    const calledWith = mockListPersistedVehicles.mock.calls[0][0];
    expect(calledWith).toContain("SomeOperator");
    expect(calledWith).toContain("servertest");
  });

  it("/vehicles on a lookup failure falls back to an empty list, never surfacing the underlying error message (which would embed the path)", async () => {
    mockGetActiveServer.mockResolvedValue({
      isRemote: false,
      zomboidDataPath: "C:\\Users\\SomeOperator\\Zomboid",
      serverName: "servertest",
    });
    mockListPersistedVehicles.mockRejectedValue(
      new Error("ENOENT: C:\\Users\\SomeOperator\\Zomboid\\Saves\\Multiplayer\\servertest\\vehicles.db"),
    );
    const { default: router } = await freshModule();
    const handler = findRoute(router, "/vehicles", "get");
    const res = makeRes();
    await handler({}, res);
    expect(res.jsonBody).toEqual({ vehicles: [] });
  });
});

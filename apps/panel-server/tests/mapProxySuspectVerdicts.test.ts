import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const mockGetActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({
  getActiveServer: (...args) => mockGetActiveServer(...args),
}));

const mockListPersistedVehicles = vi.fn();
vi.mock("../utils/vehiclesDb.ts", () => ({
  listPersistedVehicles: (...args) => mockListPersistedVehicles(...args),
}));

const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();
const mockLogDebug = vi.fn();
vi.mock("../utils/logger.ts", () => ({
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
  return await import("../routes/mapProxy.ts");
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

describe("case 1 (DEAD): path traversal / containment on tile params", () => {
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
    expect(dir).toBe("42.20.0");
    expect(getB42ResolutionStatus().source).toBe("fallback");
  });
});

describe("case 2 (DEAD as a defect): B41/B42 floor asymmetry is intentional and matches the client", () => {
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

describe("case 3 (DEAD): a genuinely missing tile is a quiet 404, not a 500, and is distinguished from a real upstream failure", () => {
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
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    try {
      const { default: router } = await freshModule();
      const handler = findRoute(router, "/b41tiles/:level/:tile", "get");
      const res = makeRes();
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

describe("case 5 (DEAD): /resolve and /vehicles never leak local filesystem paths or save names", () => {
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


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
  return await import("../routes/mapProxy.ts");
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
    const buildList = [
      { directory: "41.78.16", default: false },
      { directory: "42.19.0", default: false },
      { directory: "42.21.0", default: false },
    ];
    mockCurlRouter((url) => {
      if (url.endsWith("/api/builds/default")) {
        return curlResult(200, JSON.stringify({ directory: "42.20.0", default: true }));
      }
      if (url.endsWith("/api/builds")) {
        return curlResult(200, JSON.stringify(buildList));
      }
      if (url.includes("42.20.0/base/layer0.dzi")) {
        return curlResult(200, dziXml(GEOMETRY_42_20_0));
      }
      if (url.includes("42.21.0/base/layer0.dzi")) {
        return curlResult(200, dziXml(GEOMETRY_42_20_0));
      }
      if (url.includes("/base/map_info.json")) {
        return curlResult(200, mapInfoJson());
      }
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
    expect(dir).toBe("42.20.0");

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

describe("getB42ResolutionStatus() contract shape", () => {
  it("returns exactly {source, directory, reason} -- no more, no less, no renamed keys", async () => {
    const { getB42ResolutionStatus } = await freshModule();
    const status = getB42ResolutionStatus();
    expect(Object.keys(status).sort()).toEqual(["directory", "reason", "source"]);
    expect(typeof status.directory).toBe("string");
  });
});

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

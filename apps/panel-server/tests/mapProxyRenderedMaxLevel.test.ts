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

async function freshModule() {
  vi.resetModules();
  return await import("../routes/mapProxy.ts");
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
      return { ok: level !== null && level <= 16 };
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
      expect(headCalls).toBeLessThan(15);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("discoverRenderedMaxLevel: fails CLOSED when discovery cannot run at all", () => {
  it("keeps the verified fallback ceiling when curl itself is unavailable", async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      const err = new Error("spawn curl ENOENT");
      err.code = "ENOENT";
      callback(err);
    });

    const { default: router } = await freshModule();
    const body = await callResolve(router);

    expect(body.maxLevel).toBe(22);
    expect(body.renderedMaxLevel).toBe(22);
    expect(body.renderedMaxLevel).toBe(body.maxLevel);
  });
});

describe("GH#109 arithmetic confirmation: the reported 137%/138% zoom boundary is a real DZI level step", () => {
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

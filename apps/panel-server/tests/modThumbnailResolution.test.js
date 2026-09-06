import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  setModPreviewUrl: vi.fn(),
}));

vi.mock("../utils/paths.ts", () => ({
  getDataPaths: vi.fn(),
}));

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const STEAM_API_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const PREVIEW_URL = "https://steamuserimages-a.akamaihd.net/ugc/fake/preview.jpg";

function createResponse() {
  const response = {};
  let statusCode = 200;
  let ended = null;
  const headers = {};
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.end = (body) => {
    ended = body ?? true;
    return response;
  };
  response.setHeader = (name, value) => {
    headers[name] = value;
  };
  response.sendFile = (filePath) => {
    ended = fs.readFileSync(filePath);
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getEnded = () => ended;
  response.getHeaders = () => headers;
  return response;
}

function getRouteHandlers(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runThumbnailRoute(router, workshopId) {
  const handlers = getRouteHandlers(router, "/thumbnail/:workshopId", "get");
  const req = { params: { workshopId } };
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

async function freshModule(tempRoot) {
  vi.resetModules();
  const { getDataPaths } = await import("../utils/paths.ts");
  getDataPaths.mockReturnValue({ dataDir: tempRoot, logsDir: tempRoot });
  return await import("../routes/mods.js");
}

describe("GET /thumbnail/:workshopId — negative caching", () => {
  let tempRoot;
  let originalFetch;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mod-thumb-test-"));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("records a failure and short-circuits a repeat request with zero network calls", async () => {
    const { getTrackedMods } = await import("../database/init.js");
    getTrackedMods.mockResolvedValue([{ workshop_id: "111", preview_url: null }]);

    const fetchMock = vi.fn(async () => ({ ok: false }));
    global.fetch = fetchMock;

    const { default: router, getThumbnailResolutionStatus } = await freshModule(tempRoot);

    const first = await runThumbnailRoute(router, "111");
    expect(first.getHeaders()["Content-Type"]).toBe("image/gif");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const status = await getThumbnailResolutionStatus();
    expect(status.failing).toBe(1);
    expect(status.total).toBe(1);
    expect(status.lastError).toMatchObject({ workshopId: "111" });

    const second = await runThumbnailRoute(router, "111");
    expect(second.getHeaders()["Content-Type"]).toBe("image/gif");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(fs.readdirSync(tempRoot).filter((f) => f.endsWith(".log"))).toHaveLength(0);
  });

  it("retries after the failure TTL expires", async () => {
    const { getTrackedMods } = await import("../database/init.js");
    getTrackedMods.mockResolvedValue([{ workshop_id: "222", preview_url: null }]);

    const fetchMock = vi.fn(async () => ({ ok: false }));
    global.fetch = fetchMock;

    const { default: router, getThumbnailResolutionStatus } = await freshModule(tempRoot);

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    await runThumbnailRoute(router, "222");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 60_000);
    await runThumbnailRoute(router, "222");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    await runThumbnailRoute(router, "222");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const status = await getThumbnailResolutionStatus();
    expect(status.failing).toBe(1);
  });

  it("clears the failure on a later successful resolution", async () => {
    const { getTrackedMods } = await import("../database/init.js");
    getTrackedMods.mockResolvedValue([{ workshop_id: "333", preview_url: null }]);

    let steamShouldSucceed = false;
    global.fetch = vi.fn(async (url) => {
      if (String(url) === STEAM_API_URL) {
        if (!steamShouldSucceed) return { ok: false };
        return {
          ok: true,
          json: async () => ({
            response: {
              publishedfiledetails: [{ result: 1, preview_url: PREVIEW_URL }],
            },
          }),
        };
      }
      return {
        ok: true,
        headers: { get: (h) => (h === "content-type" ? "image/jpeg" : "40") },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      };
    });

    const { default: router, getThumbnailResolutionStatus } = await freshModule(tempRoot);

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(2_000_000);
    await runThumbnailRoute(router, "333");
    expect((await getThumbnailResolutionStatus()).failing).toBe(1);

    steamShouldSucceed = true;
    nowSpy.mockReturnValue(2_000_000 + 5 * 60 * 1000 + 1);
    const retried = await runThumbnailRoute(router, "333");
    expect(retried.getHeaders()["Content-Type"]).toBe("image/jpeg");

    const status = await getThumbnailResolutionStatus();
    expect(status.failing).toBe(0);
  });

  it("getThumbnailResolutionStatus() reports {failing, total, lastError} with no unresolved failures on a clean start", async () => {
    const { getTrackedMods } = await import("../database/init.js");
    getTrackedMods.mockResolvedValue([
      { workshop_id: "1", preview_url: "https://images.steamusercontent.com/x" },
      { workshop_id: "2", preview_url: "https://images.steamusercontent.com/y" },
    ]);

    const { getThumbnailResolutionStatus } = await freshModule(tempRoot);
    const status = await getThumbnailResolutionStatus();
    expect(status).toEqual({ failing: 0, total: 2, lastError: null });
  });
});

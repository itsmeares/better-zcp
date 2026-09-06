import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression/coverage for conv-modthumbnails: GET /thumbnail/:workshopId never
// wrote a FAILED resolution to its disk cache, so a host where resolution is
// broken (missing preview_url + an unreachable/failing Steam) re-ran a full
// Steam round trip for EVERY tracked mod on EVERY page load, forever --
// needless third-party load and a self-inflicted slow page, discovered while
// investigating a "thumbnails never render" report that turned out NOT to be
// the removed-markup bug it first looked like (see conv-modthumbnails).
// THUMB_FAIL_CACHE now remembers a failure for a bounded TTL so it can be
// skipped cheaply -- these tests prove it actually short-circuits, actually
// expires, and actually clears on a later success, plus the diagnostics shape
// getThumbnailResolutionStatus() exposes for the Debug support bundle.

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  setModPreviewUrl: vi.fn(),
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: vi.fn(),
}));

// 2026-08-29, ENOTEMPTY class fix: this file mocked getDataPaths() to point
// at its own mkdtemp'd tempRoot without also mocking the logger, so the
// REAL winston logger (createLogger() is not mocked elsewhere in this file)
// resolved its logsDir into that same tempRoot and wrote real, asynchronous
// combined.log/error.log files into it -- confirmed live (a two-line
// diagnostic listing tempRoot's contents at the end of a test body found
// them there, before afterEach ever runs). afterEach's fs.rmSync is
// synchronous and unconditional; a real, un-awaited winston write still in
// flight when it walks the directory is an ENOTEMPTY waiting to happen
// under load, independent of whether this specific run ever caught it.
// Matches the SAME logger-mocking shape already established elsewhere in
// this suite (see e.g. linuxLaunchExtensionlessCustomCommand.test.js,
// linuxScanAmbiguousProcessDetection.test.js) -- adopting an existing
// convention this file simply never had a reason to reach for, not
// inventing a new one. This test doesn't assert on anything the logger
// does, so there is nothing to lose by removing the real one.
vi.mock("../utils/logger.js", () => ({
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
  const { getDataPaths } = await import("../utils/paths.js");
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

    // Second request, same mod, well within the TTL: must not touch the
    // network at all -- that's the entire point of the negative cache.
    const second = await runThumbnailRoute(router, "111");
    expect(second.getHeaders()["Content-Type"]).toBe("image/gif");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Regression proof for the ENOTEMPTY class (2026-08-29): before the
    // logger.js mock above, a real winston logger wrote combined.log/
    // error.log into this exact tempRoot -- confirmed live via a one-off
    // diagnostic. Nothing this route does legitimately produces a *.log
    // file (the mod-thumbnails cache writes an image, never a log), so
    // this stays a meaningful, permanent assertion rather than a diagnostic
    // that gets deleted after proving the point once.
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

    // Still well inside the TTL: short-circuited, no second network call.
    nowSpy.mockReturnValue(1_000_000 + 60_000);
    await runThumbnailRoute(router, "222");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the TTL (5 minutes): a transient outage must not blank the
    // thumbnail forever, so this must retry for real.
    nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    await runThumbnailRoute(router, "222");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const status = await getThumbnailResolutionStatus();
    expect(status.failing).toBe(1); // the retry failed too (fetch always ok:false)
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
      // Image download from the (allow-listed) CDN host.
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

    // Past the TTL, and Steam now resolves successfully.
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

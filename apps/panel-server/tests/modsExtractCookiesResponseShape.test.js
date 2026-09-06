import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-08-26 bug hunt: POST /collection/extract-cookies used to return the
// raw, live Steam sessionid/steamLoginSecure directly in the response body.
// Traced the client and found the values were never displayed -- they were
// immediately POSTed straight back to a save endpoint. Fixed by having the
// route save the credentials itself and report only success, so a
// technician-tier caller (this router's own permission floor) can no
// longer ask this one endpoint for the panel host's live Steam login
// token. This pins the response shape on both branches, and that the save
// actually happens server-side rather than being left to the caller.

const { extractSteamCookies, listAvailableBrowsers } = vi.hoisted(() => ({
  extractSteamCookies: vi.fn(),
  listAvailableBrowsers: vi.fn(),
}));
const { setSteamSessionCredentials, getSteamSessionCredentials } = vi.hoisted(() => ({
  setSteamSessionCredentials: vi.fn(),
  getSteamSessionCredentials: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));
vi.mock("../utils/browserCookies.js", () => ({
  listAvailableBrowsers,
  extractSteamCookies,
}));
vi.mock("../services/workshopCollectionSync.js", () => ({
  getCollectionContents: vi.fn(),
  addItemToCollection: vi.fn(),
  removeItemFromCollection: vi.fn(),
  computeDiff: vi.fn(),
  syncSingleChange: vi.fn(),
  fetchPublishedFileTitles: vi.fn(),
  getSteamSessionCredentials,
  setSteamSessionCredentials,
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

describe("POST /collection/extract-cookies: response shape", () => {
  beforeEach(() => {
    extractSteamCookies.mockReset();
    setSteamSessionCredentials.mockReset();
  });

  it("saves the credentials server-side and never puts them in the response", async () => {
    extractSteamCookies.mockResolvedValue({
      ok: true,
      browser: "chrome",
      sessionid: "abc123-live-session",
      steamLoginSecure: "76500000000000000%7C%7Cdeadbeef",
      missing: [],
      notes: ["1 cookie(s) are sealed by Chrome 127+ App-Bound Encryption."],
    });

    const res = await runRoute("/collection/extract-cookies", "post", {
      body: { browser: "chrome" },
    });

    expect(setSteamSessionCredentials).toHaveBeenCalledWith(
      "abc123-live-session",
      "76500000000000000%7C%7Cdeadbeef",
    );

    const body = res.getBody();
    expect(body).toEqual({
      ok: true,
      browser: "chrome",
      saved: true,
      notes: ["1 cookie(s) are sealed by Chrome 127+ App-Bound Encryption."],
    });
    expect(body).not.toHaveProperty("sessionid");
    expect(body).not.toHaveProperty("steamLoginSecure");
  });

  it("does not save anything, and leaves the failure shape unchanged, when extraction fails", async () => {
    extractSteamCookies.mockResolvedValue({
      ok: false,
      browser: "firefox",
      sessionid: null,
      steamLoginSecure: null,
      missing: ["sessionid", "steamLoginSecure"],
      notes: [],
      error: "Missing sessionid + steamLoginSecure — make sure you're logged into Steam in this browser",
    });

    const res = await runRoute("/collection/extract-cookies", "post", {
      body: { browser: "firefox" },
    });

    expect(setSteamSessionCredentials).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({
      ok: false,
      browser: "firefox",
      error: expect.stringContaining("Missing sessionid"),
    });
  });
});

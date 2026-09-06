import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression: POST /write-to-ini put every workshopId into WorkshopItems=
// unconditionally, but silently dropped a mod from Mods= whenever its modId
// couldn't be auto-detected (local file scan + Steam Workshop page lookup
// both failing -- a real, reachable condition, not hypothetical). The
// response still said `success: true` with no field listing which mods
// ended up subscribed-but-not-enabled, so a caller had no way to tell
// "all N mods configured" from "N mods subscribed, fewer actually enabled".

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
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

describe("POST /write-to-ini: unresolved modId reporting", () => {
  let dataRoot;
  let originalFetch;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-write-to-ini-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(path.join(configPath, "TestServer.ini"), "Mods=\nWorkshopItems=\n");
    // No installPath -- skips local-file modId detection entirely so only
    // the Steam Workshop page lookup (fetch, mocked below) resolves modId.
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
    originalFetch = global.fetch;
    // Steam API unreachable/erroring for every workshop ID -- forces modId
    // auto-detection to fail deterministically, without a real network call.
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  it("reports unresolvedModIds and still subscribes them via WorkshopItems=", async () => {
    const res = await runRoute("/write-to-ini", "post", {
      body: {
        mods: [
          { workshopId: "1111111111", modId: "KnownGoodMod" },
          { workshopId: "2222222222" }, // no modId -- detection will fail
        ],
      },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.unresolvedModIds).toEqual(["2222222222"]);
    expect(body.message).toContain("2222222222");
    expect(body.message).toMatch(/could not be auto-detected/i);

    // The unresolved workshop ID is still subscribed (WorkshopItems=)...
    expect(body.workshopItems).toContain("2222222222");
    // ...but never made it into Mods=, so PZ won't actually load it.
    const iniContent = fs.readFileSync(
      path.join(dataRoot, "Server", "TestServer.ini"),
      "utf-8",
    );
    const modsLine = iniContent.match(/^Mods=(.*)$/m)?.[1] || "";
    expect(modsLine).not.toContain("2222222222");
    expect(modsLine).toContain("KnownGoodMod");
  });

  it("leaves unresolvedModIds empty when every mod resolves", async () => {
    const res = await runRoute("/write-to-ini", "post", {
      body: {
        mods: [{ workshopId: "3333333333", modId: "AnotherKnownMod" }],
      },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.unresolvedModIds).toEqual([]);
    expect(body.message).not.toMatch(/could not be auto-detected/i);
  });
});

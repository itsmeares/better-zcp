import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Bug hunt 2026-08-31 (server-routes slice): POST /add-all-resolved-deps
// resolves each dep's PZ mod ID via a best-effort Steam-description scrape
// (fetchModIdFromWorkshop) that routinely returns null -- many workshop
// items don't declare a Mod ID in their description, which is exactly why
// they showed up as a missing dep in the first place. When that happens the
// route still adds the workshop ID to WorkshopItems= but can't add anything
// to Mods= (there's no ID to add), leaving that one dependency subscribed
// but not enabled -- the orphan state /resolve-orphan-workshop has its own
// diagnostic for. The response used to report only aggregate wsAdded/
// modIdsAdded counts and success:true, with no way for a caller to tell
// WHICH dep (if any) failed to resolve. Paired with ConflictsPanel.tsx's
// handleFixAll (apps/panel-client/src/components/mods -- Jim's slice, not fixed here),
// which marked every requested row "added" on any non-throwing response,
// this made the panel report a fix that hadn't actually happened for that
// one dependency. This test locks in the new per-item `results[]` field
// that lets a caller tell the difference.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
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

describe("POST /add-all-resolved-deps: per-item results[]", () => {
  let dataRoot;
  let fetchMock;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-add-all-resolved-deps-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=\nWorkshopItems=\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
      // No installPath -- keeps serverPath null so findModIdFromWorkshop()
      // never runs and fetchModIdFromWorkshop() is the only resolution path,
      // which the fetch stub below controls deterministically.
    });
    // The unresolved dep (no dep.modId supplied) falls through to
    // fetchModIdFromWorkshop(), which calls the real global fetch. Stub it
    // to the "Steam has no info for this item" branch (response.ok===false)
    // so resolution deterministically fails without a real network call.
    fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("reports a non-null modId for a dep whose mod ID was supplied and modId:null for one that couldn't be resolved", async () => {
    const res = await runRoute("/add-all-resolved-deps", "post", {
      body: {
        deps: [
          { workshopId: "1111111111", modId: "KnownGoodMod" },
          { workshopId: "2222222222" },
        ],
      },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);

    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual({
      workshopId: "1111111111",
      modId: "KnownGoodMod",
      wsAdded: true,
      modIdAdded: true,
    });
    expect(body.results[1]).toEqual({
      workshopId: "2222222222",
      modId: null,
      wsAdded: true,
      modIdAdded: false,
    });

    // The aggregate counts alone can't distinguish this batch from one where
    // every dep resolved -- results[] is what makes the failure visible.
    expect(body.wsAdded).toBe(2);
    expect(body.modIdsAdded).toBe(1);

    const iniContent = fs.readFileSync(
      path.join(dataRoot, "Server", "TestServer.ini"),
      "utf-8",
    );
    const wsLine = iniContent.match(/^WorkshopItems=(.*)$/m)?.[1] || "";
    const modsLine = iniContent.match(/^Mods=(.*)$/m)?.[1] || "";
    expect(wsLine.split(";").filter(Boolean)).toEqual(
      expect.arrayContaining(["1111111111", "2222222222"]),
    );
    // The unresolved dep's workshop ID reached WorkshopItems= but has no
    // corresponding entry in Mods= -- subscribed, not enabled.
    expect(modsLine.split(";").filter(Boolean)).toEqual(["KnownGoodMod"]);
  });

  it("returns a non-null modId with wsAdded/modIdAdded both false for a dep that was already fully present", async () => {
    fs.writeFileSync(
      path.join(dataRoot, "Server", "TestServer.ini"),
      "Mods=AlreadyThereMod\nWorkshopItems=3333333333\n",
    );

    const res = await runRoute("/add-all-resolved-deps", "post", {
      body: {
        deps: [{ workshopId: "3333333333", modId: "AlreadyThereMod" }],
      },
    });

    expect(res.getBody().results[0]).toEqual({
      workshopId: "3333333333",
      modId: "AlreadyThereMod",
      wsAdded: false,
      modIdAdded: false,
    });
  });
});

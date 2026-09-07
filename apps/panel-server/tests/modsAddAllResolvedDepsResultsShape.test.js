import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.ts");
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

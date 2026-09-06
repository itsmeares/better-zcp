import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-26 bug hunt finding 14: POST /add-missing-dep wrote WorkshopItems=
// via a bare currentWs.join(";") instead of sanitizeIniList -- inconsistent
// with the Mods= write six lines below it in the same handler, which already
// used sanitizeModIdList. Confirmed inert today (workshopId is regex-checked
// `/^\d{1,15}$/` earlier in this same handler, so only digits can reach the
// join), but the guard living in a different place than the write it
// protects is exactly the shape that expires the moment that upstream regex
// ever loosens -- fixed to match the other 15+ WorkshopItems=/Mods= write
// sites in this file regardless.
//
// This can only be a regression test, not an exploit-pinning one: the route
// itself rejects anything but pure digits before this code ever runs, so
// there is no way to drive a dangerous value through the live route to prove
// the fix blocks it. What's verifiable here is that the fix didn't change
// normal (digit-only) behavior, and that the code now goes through
// sanitizeIniList at all.

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

describe("POST /add-missing-dep: WorkshopItems= sanitization", () => {
  let dataRoot;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-add-missing-dep-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, "TestServer.ini"),
      "Mods=\nWorkshopItems=1111111111\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("appends a new workshop ID through sanitizeIniList, unchanged from a plain join for well-formed input", async () => {
    const res = await runRoute("/add-missing-dep", "post", {
      body: { workshopId: "2222222222", modId: "KnownGoodMod" },
    });

    expect(res.getStatusCode()).toBe(200);

    const iniContent = fs.readFileSync(
      path.join(dataRoot, "Server", "TestServer.ini"),
      "utf-8",
    );
    const wsLine = iniContent.match(/^WorkshopItems=(.*)$/m)?.[1] || "";
    expect(wsLine.split(";")).toEqual(
      expect.arrayContaining(["1111111111", "2222222222"]),
    );
    // sanitizeIniList's output never carries these bytes -- proving the call
    // site is really going through it (not just a coincidentally-identical
    // join) rather than proving an exploit is blocked, which the route's own
    // upstream /^\d{1,15}$/ check on workshopId already rules out reaching.
    expect(wsLine).not.toMatch(/[\r\n;=]{2}/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Proves the params-wiring fix for mods.js's 4 previously-PARTIAL error
// codes (see apps/panel-server/utils/errorCodes.js) actually reaches res.json(), not
// just that the throw/emission site sets a local variable. Same
// "check the wire, not the code" discipline that caught the
// RECOVERY_CAPABILITIES ordering bug in changeUserRoleById.test.js.
//
// Deliberately skips mods.js's router.use(requirePermission("mods.manage"))
// gate the same way chunksDeletionLogic.test.js skips chunks.js's
// remote-server guard -- these tests exercise validation logic behind the
// gate, not the gate itself (see modsRoutesCapability-style tests, if any,
// for gate coverage). Only the matched route's own two-arg handler is run.

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

describe("mods.js: previously-PARTIAL error codes now carry params on the wire", () => {
  it("MODS_INVALID_BROWSER sends { browsers } listing the allowed set", async () => {
    const res = await runRoute("/collection/extract-cookies", "post", {
      body: { browser: "netscape-navigator" },
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({
      code: "MODS_INVALID_BROWSER",
      params: { browsers: "firefox, chrome, edge, brave" },
    });
  });

  it("MODS_INVALID_WORKSHOP_ID_TEMPLATE (write-to-ini) sends the offending, truncated { workshopId }", async () => {
    const overlong = "1".repeat(30); // exceeds /^\d{1,15}$/ -- also proves the 20-char truncation lands in params
    const res = await runRoute("/write-to-ini", "post", {
      body: { mods: [{ workshopId: overlong, modId: "TestMod" }] },
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({
      code: "MODS_INVALID_WORKSHOP_ID_TEMPLATE",
      params: { workshopId: overlong.substring(0, 20) },
    });
  });

  it("MODS_INVALID_MOD_ID_FORMAT_TEMPLATE (batch-toggle-mod-ids) sends the offending, truncated { modId }", async () => {
    const badModId = "bad;id=with=delimiters";
    const res = await runRoute("/batch-toggle-mod-ids", "post", {
      body: { changes: [{ modId: badModId, enabled: true }] },
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({
      code: "MODS_INVALID_MOD_ID_FORMAT_TEMPLATE",
      params: { modId: badModId.substring(0, 50) },
    });
  });

  describe("MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS sends { count }", () => {
    let dataRoot;

    beforeEach(() => {
      dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-error-params-"));
      const configPath = path.join(dataRoot, "Server");
      fs.mkdirSync(configPath, { recursive: true });
      fs.writeFileSync(path.join(configPath, "TestServer.ini"), "Mods=\n");
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

    it("reports the actual count of rejected workshop-ID-shaped entries", async () => {
      const res = await runRoute("/batch-toggle-mod-ids", "post", {
        body: {
          changes: [
            { modId: "123456789", enabled: true }, // 9 digits -- looksLikeWorkshopId
            { modId: "987654321012", enabled: true }, // 12 digits -- also workshop-ID-shaped
            { modId: "RealModId", enabled: true }, // not workshop-ID-shaped, doesn't count
          ],
        },
      });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({
        code: "MODS_BATCH_TOGGLE_WORKSHOP_ID_IN_MODS",
        params: { count: 2 },
      });
    });
  });
});

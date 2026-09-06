import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /server-files/save-and-reload hardcoded `success: true` regardless of
// what the RCON reloadoptions call actually returned -- diagnosed in
// the route hunt's Finding 3, confirmed still present in current
// code before this fix. reloadOptions() is a thin wrapper over
// RconService.execute(), which DOES distinguish success from failure
// (`{success:false, error}` on a failed/unknown-command reply, timeout, or
// disconnected RCON) -- this route just never looked at that field. The
// sibling route config.js's POST /reload already does this honestly
// (`res.json(result)`, passing the real result straight through).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

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

function postSaveAndReload(rconService) {
  return runRoute("/save-and-reload", "post", {
    user: { role: "admin" },
    body: {},
    app: { get: (key) => (key === "rconService" ? rconService : null) },
  });
}

describe("serverFiles.js POST /save-and-reload: the response must reflect what RCON actually reported", () => {
  it("reports success:false and the real error when RCON's reloadoptions call itself failed", async () => {
    const res = await postSaveAndReload({
      isConnected: () => true,
      reloadOptions: async () => ({ success: false, error: "Command execution timed out" }),
    });

    expect(res.getBody()).toMatchObject({
      success: false,
      error: "Command execution timed out",
    });
  });

  it("still reports success:true when RCON genuinely reloaded the options", async () => {
    const res = await postSaveAndReload({
      isConnected: () => true,
      reloadOptions: async () => ({ success: true, response: "OK" }),
    });

    expect(res.getBody()).toMatchObject({ success: true });
  });

  it("still refuses up front when RCON isn't connected at all (unchanged behavior)", async () => {
    const res = await postSaveAndReload({ isConnected: () => false });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "SAVE_AND_RELOAD_RCON_NOT_CONNECTED" });
  });
});

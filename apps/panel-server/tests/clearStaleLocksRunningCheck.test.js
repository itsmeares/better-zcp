import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


const getActiveServer = vi.fn();
vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName: mockGetRoleByName, getActiveServer };
});

const { default: router } = await import("../routes/debug.js");

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

function postClearStaleLocks(serverManager) {
  return runRoute("/clear-stale-locks", "post", {
    user: { role: "admin" },
    body: {},
    app: { get: (key) => (key === "serverManager" ? serverManager : null) },
  });
}

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue(null);
});

describe("debug.js POST /clear-stale-locks: an undetermined server state must refuse, not be read as 'stopped'", () => {
  it("refuses (503) and never reaches the active-server lookup when the running-scan itself failed (scanFailed:true)", async () => {
    const res = await postClearStaleLocks({
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    });

    expect(res.getStatusCode()).toBe(503);
    expect(getActiveServer).not.toHaveBeenCalled();
  });

  it("refuses (503) rather than falling back to the unrelated isRunning flag when the running-check itself throws", async () => {
    const res = await postClearStaleLocks({
      isRunning: false, // the old fallback would have read this as "stopped, proceed"
      checkServerRunning: async () => {
        throw new Error("boom-process-scan");
      },
      getServerProcessDetails: async () => {
        throw new Error("boom-process-scan");
      },
    });

    expect(res.getStatusCode()).toBe(503);
    expect(getActiveServer).not.toHaveBeenCalled();
  });

  it("still refuses (409) on a confirmed-running server", async () => {
    const res = await postClearStaleLocks({
      checkServerRunning: async () => true,
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    });

    expect(res.getStatusCode()).toBe(409);
    expect(getActiveServer).not.toHaveBeenCalled();
  });

  it("proceeds past the running-check when the scan confirms the server is stopped", async () => {
    const res = await postClearStaleLocks({
      checkServerRunning: async () => false,
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    });

    expect(getActiveServer).toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(400);
  });
});

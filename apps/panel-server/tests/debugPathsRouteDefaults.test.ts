import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.ts";


const setDataPaths = vi.fn();
const getServers = vi.fn();
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

vi.mock("../utils/paths.ts", async () => {
  const actual = await vi.importActual("../utils/paths.ts");
  return { ...actual, setDataPaths };
});

vi.mock("../database/init.ts", async () => {
  const actual = await vi.importActual("../database/init.ts");
  return { ...actual, getRoleByName: mockGetRoleByName, getServers };
});

const { default: router } = await import("../routes/debug.ts");

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

async function postPaths(body) {
  const handlers = getRouteHandlers("/paths", "post");
  const res = createResponse();
  const req = { user: { role: "admin" }, body, app: { get: () => null } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

beforeEach(() => {
  setDataPaths.mockReset().mockResolvedValue({
    success: true,
    paths: { dataDir: "/x/data", logsDir: "/x/logs" },
    filesMoved: { data: false, logs: false },
  });
  getServers.mockReset().mockResolvedValue([]);
});

describe("POST /debug/paths: moveFiles default", () => {
  it("passes moveFiles=false to setDataPaths when the body omits the key entirely", async () => {
    await postPaths({ dataDir: "/new/data" });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      false,
      expect.any(Object),
    );
  });

  it("passes moveFiles=true only when the body explicitly sets it to the boolean true", async () => {
    await postPaths({ dataDir: "/new/data", moveFiles: true });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      true,
      expect.any(Object),
    );
  });

  it("treats a truthy non-boolean value the same as absent -- strict === true, not a loose truthy check", async () => {
    await postPaths({ dataDir: "/new/data", moveFiles: "true" });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      false,
      expect.any(Object),
    );
  });

  it("passes moveFiles=false when the body explicitly sets it to false (unchanged from before)", async () => {
    await postPaths({ dataDir: "/new/data", moveFiles: false });
    expect(setDataPaths).toHaveBeenCalledWith(
      { dataDir: "/new/data", logsDir: undefined },
      false,
      expect.any(Object),
    );
  });
});

describe("POST /debug/paths: extraBlockedPaths wiring", () => {
  it("collects installPath and zomboidDataPath from every configured server", async () => {
    getServers.mockResolvedValue([
      { id: 1, installPath: "/srv/pz1", zomboidDataPath: "/data/zomboid1" },
      { id: 2, installPath: "/srv/pz2", zomboidDataPath: null },
    ]);

    await postPaths({ dataDir: "/new/data" });

    expect(setDataPaths).toHaveBeenCalledWith(
      expect.any(Object),
      false,
      { extraBlockedPaths: ["/srv/pz1", "/data/zomboid1", "/srv/pz2"] },
    );
  });

  it("passes an empty extraBlockedPaths array when no servers are configured", async () => {
    getServers.mockResolvedValue([]);
    await postPaths({ dataDir: "/new/data" });
    expect(setDataPaths).toHaveBeenCalledWith(expect.any(Object), false, { extraBlockedPaths: [] });
  });
});

describe("POST /debug/client-errors log safety", () => {
  it("keeps a public client message on one log line", async () => {
    const handlers = getRouteHandlers("/client-errors", "post");
    const res = createResponse();
    logWarn.mockClear();

    await handlers[0](
      {
        ip: "203.0.113.10",
        body: { message: "client failed\r\n[INFO] forged entry" },
      },
      res,
      vi.fn(),
    );

    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0][0]).toBe(
      "[ClientError] client failed [INFO] forged entry",
    );
    expect(logWarn.mock.calls[0][0]).not.toMatch(/[\r\n]/);
    expect(res.getBody()).toEqual({ ok: true });
  });
});

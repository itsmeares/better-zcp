import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


vi.mock("../database/init.ts", async () => {
  const actual = await vi.importActual("../database/init.ts");
  return { ...actual, getRoleByName: mockGetRoleByName };
});

const { getDataPaths } = await import("../utils/paths.ts");
const { default: debugRouter, formatDbAccessibleMessage } = await import("../routes/debug.ts");

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

function getLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getLayer(router, routePath, method);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function adminReq(overrides = {}) {
  return {
    user: { role: "admin" },
    params: {},
    query: {},
    body: {},
    app: { get: () => undefined },
    ...overrides,
  };
}

describe("debug.js crash-logs: scans the configured logs directory, not process.cwd()", () => {
  it("GET /crash-logs finds a crash-shaped file placed in getDataPaths().logsDir", async () => {
    const { logsDir } = getDataPaths();
    const markerFile = path.join(logsDir, "hs_err_pid99999.log");
    fs.writeFileSync(markerFile, "fake crash dump for this test");
    try {
      const res = await runRoute(debugRouter, "/crash-logs", "get", adminReq());
      expect(res.getStatusCode()).toBe(200);
      const names = res.getBody().crashLogs.map((c) => c.name);
      expect(names).toContain("hs_err_pid99999.log");
    } finally {
      fs.rmSync(markerFile, { force: true });
    }
  });

  it("GET /crash-logs/:filename reads the same file's content from the configured logs directory", async () => {
    const { logsDir } = getDataPaths();
    const markerFile = path.join(logsDir, "crash-drift-test.log");
    fs.writeFileSync(markerFile, "distinctive content only this test writes");
    try {
      const res = await runRoute(debugRouter, "/crash-logs/:filename", "get", adminReq({
        params: { filename: "crash-drift-test.log" },
      }));
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().content).toContain("distinctive content only this test writes");
    } finally {
      fs.rmSync(markerFile, { force: true });
    }
  });
});

describe("debug.js formatDbAccessibleMessage: the diagnostics 'Database accessible' check", () => {
  it("was structurally incapable of ever printing anything but '? collections, 0 MB' -- reports the real numbers now", () => {
    const dbStats = {
      fileSizeBytes: 5 * 1024 * 1024, // 5 MB
      collections: {
        command_history: 3,
        scheduled_tasks: 0,
        servers: 1,
      },
    };
    expect(formatDbAccessibleMessage(dbStats)).toBe("3 collections, 5 MB.");
  });

  it("still reports '?' when dbStats itself is unavailable (timeout/failure upstream), not a crash", () => {
    expect(formatDbAccessibleMessage(null)).toBe("? collections, ?.");
    expect(formatDbAccessibleMessage(undefined)).toBe("? collections, ?.");
  });

  it("reports 0 MB honestly (not '?') for a real, empty database file", () => {
    expect(formatDbAccessibleMessage({ fileSizeBytes: 0, collections: {} })).toBe("0 collections, 0 MB.");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /debug/clear-stale-locks walks the active save folder deleting
// stale *.lock files, bounded by MAX_FILES=50,000 and (as of this fix) a
// wall-clock deadline, using the same safeReaddir/safeStat primitives as
// scanSaveStats (see scanSaveStatsDeadline.test.js) instead of raw
// fs.promises calls with no per-op timeout. Unlike GET /diagnostics's
// scanSaveStats, this route already returned a `truncated` boolean in its
// JSON body before this fix -- but the human-readable `message` field never
// mentioned it, so a caller reading just the toast text (which is what the
// client actually renders, per Debug.tsx) had no way to know the scan
// stopped early. These tests prove the message now says so.

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

const RUNNING_OK = {
  checkServerRunning: async () => false,
  getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
};

function postClearStaleLocks() {
  return runRoute("/clear-stale-locks", "post", {
    user: { role: "admin" },
    body: {},
    app: { get: (key) => (key === "serverManager" ? RUNNING_OK : null) },
  });
}

const ZOMBOID_DATA_PATH = path.join("C:", "zdata");
const SAVE_DIR = path.join(ZOMBOID_DATA_PATH, "Saves", "Multiplayer", "MyServer");
const STALE_MTIME = () => Date.now() - 2 * 60 * 60 * 1000; // 2h old, past the 1h threshold

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue({
    zomboidDataPath: ZOMBOID_DATA_PATH,
    serverName: "MyServer",
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /clear-stale-locks: honest truncation reporting", () => {
  it("reports truncated: true and says so in the message when the save is too large to finish within budget", async () => {
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      if (p === SAVE_DIR) {
        return { isDirectory: () => true, isFile: () => false };
      }
      // 20s "cost" per file -- the 30s walk budget only fits ~1 before the
      // deadline check trips on the next iteration.
      vi.setSystemTime(new Date(Date.now() + 20_000));
      return { isDirectory: () => false, isFile: () => true, mtimeMs: STALE_MTIME() };
    });
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => `a${i}.lock`),
    );
    vi.spyOn(fs.promises, "unlink").mockResolvedValue(undefined);

    const res = await postClearStaleLocks();

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.truncated).toBe(true);
    expect(body.message).toMatch(/stopped early/i);
    expect(body.deleted).toBeLessThan(10);
  });

  it("reports truncated: false with no early-stop wording when the whole save fits in the budget", async () => {
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      if (p === SAVE_DIR) {
        return { isDirectory: () => true, isFile: () => false };
      }
      return { isDirectory: () => false, isFile: () => true, mtimeMs: STALE_MTIME() };
    });
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(["a.lock", "b.lock"]);
    vi.spyOn(fs.promises, "unlink").mockResolvedValue(undefined);

    const res = await postClearStaleLocks();

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.truncated).toBe(false);
    expect(body.deleted).toBe(2);
    expect(body.message).not.toMatch(/stopped early/i);
  });
});

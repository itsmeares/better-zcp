import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /debug/fix-writability clears the read-only attribute on ONE
// server-resolved file (currently only "db" -> getDataPaths().dbPath) and
// re-checks writability -- see the route's own comment in
// apps/panel-server/routes/debug.js for the full safety reasoning (closed target
// enum, file-only, honest failure on a real ACL/ownership issue).
//
// Deliberately exercises the REAL filesystem (a temp file under
// os.tmpdir(), genuinely marked read-only via fs.chmodSync) rather than
// mocking fs.promises.chmod -- the entire value of this route is that a
// real chmod call actually restores writability on this platform, so a
// fully-mocked test would prove nothing about whether the fix works.

// utils/logger.js calls getDataPaths() once at module load time (for its
// own logsDir), which happens before any beforeEach() runs -- give the
// mock a real-shaped default up front so that first call doesn't blow up,
// same fix documented in panelBridgeSftp.test.js for the identical issue.
const getDataPaths = vi.fn(() => ({ dataDir: ".", logsDir: ".", dbPath: "" }));
vi.mock("../utils/paths.js", async () => {
  const actual = await vi.importActual("../utils/paths.js");
  return { ...actual, getDataPaths };
});

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName: mockGetRoleByName };
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

function postFixWritability(body) {
  return runRoute("/fix-writability", "post", {
    user: { role: "admin" },
    body,
    app: { get: () => null },
  });
}

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-writability-test-"));
  dbPath = path.join(tmpDir, "db.json");
  fs.writeFileSync(dbPath, "{}", "utf8");
  getDataPaths.mockReset().mockReturnValue({ dbPath });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    // Restore write access before cleanup -- rmSync on a read-only file
    // can itself fail on some platforms.
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // File may already be gone or never made read-only in a given test.
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /fix-writability", () => {
  it("rejects an unsupported target without touching the filesystem", async () => {
    fs.chmodSync(dbPath, 0o400);
    const res = await postFixWritability({ target: "logs" });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("WRITABILITY_TARGET_UNSUPPORTED");
    // Confirm nothing was touched -- still read-only. Assert the MODE
    // bits directly rather than "can I write to it": a write-attempt
    // proxy is false as root (root bypasses POSIX permission checks
    // entirely, so an append would succeed even on a 0o400 file), but
    // the mode bits themselves are true regardless of who is asking.
    expect(fs.statSync(dbPath).mode & 0o222).toBe(0);
  });

  it("rejects a missing target field the same way as an unsupported one", async () => {
    const res = await postFixWritability({});
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("WRITABILITY_TARGET_UNSUPPORTED");
  });

  it("404s when the target file does not exist", async () => {
    fs.rmSync(dbPath);
    const res = await postFixWritability({ target: "db" });

    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().code).toBe("WRITABILITY_TARGET_MISSING");
  });

  it("clears a real read-only file and reports success", async () => {
    fs.chmodSync(dbPath, 0o400); // read-only
    expect(fs.statSync(dbPath).mode & 0o222).toBe(0);

    const res = await postFixWritability({ target: "db" });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.path).toBe(dbPath);
    // The real, load-bearing assertion: the chmod actually happened, not
    // just that the route claimed success. Assert the MODE bits rather
    // than a write attempt -- root bypasses POSIX write checks, so
    // "did the write succeed" is not a reliable proxy for "did the mode
    // change" when this suite runs as root (e.g. the WSL/Linux CI gate).
    expect(fs.statSync(dbPath).mode & 0o200).toBeTruthy();
  });

  it("is a harmless no-op (still success) when the file was already writable", async () => {
    const res = await postFixWritability({ target: "db" });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("reports an honest failure, not a false success, when chmod itself throws", async () => {
    const chmodSpy = vi
      .spyOn(fs.promises, "chmod")
      .mockRejectedValue(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));

    const res = await postFixWritability({ target: "db" });

    expect(res.getStatusCode()).toBe(400);
    const body = res.getBody();
    expect(body.success).toBe(false);
    expect(body.code).toBe("WRITABILITY_CHMOD_FAILED");
    expect(body.error).toMatch(/EPERM/);
    chmodSpy.mockRestore();
  });

  it("reports an honest failure when the file is still unwritable after chmod succeeds (ACL, not attribute)", async () => {
    // chmod itself resolves (as it would on a real ACL-denied file on some
    // platforms), but the file is genuinely still not writable afterward.
    const chmodSpy = vi.spyOn(fs.promises, "chmod").mockResolvedValue(undefined);
    fs.chmodSync(dbPath, 0o400);

    // The route's post-chmod recheck goes through fs.promises.access(p,
    // W_OK). That call is not a reliable "still blocked" signal as root --
    // root bypasses POSIX write checks and access() would report writable
    // regardless of mode. Force the recheck itself to see "still blocked"
    // (rejecting only the W_OK call; the existence check earlier in the
    // route uses access() with no mode and must keep succeeding) so this
    // test proves the route's honest-failure branch independent of the
    // uid running the suite.
    const realAccess = fs.promises.access.bind(fs.promises);
    const accessSpy = vi
      .spyOn(fs.promises, "access")
      .mockImplementation(async (p, mode) => {
        if (mode === fs.constants.W_OK) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return realAccess(p, mode);
      });

    const res = await postFixWritability({ target: "db" });

    expect(res.getStatusCode()).toBe(400);
    const body = res.getBody();
    expect(body.success).toBe(false);
    expect(body.code).toBe("WRITABILITY_STILL_BLOCKED");
    accessSpy.mockRestore();
    chmodSpy.mockRestore();
  });
});

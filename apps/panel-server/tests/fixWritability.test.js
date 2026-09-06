import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


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
    fs.chmodSync(dbPath, 0o400);
    expect(fs.statSync(dbPath).mode & 0o222).toBe(0);

    const res = await postFixWritability({ target: "db" });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.path).toBe(dbPath);
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
    const chmodSpy = vi.spyOn(fs.promises, "chmod").mockResolvedValue(undefined);
    fs.chmodSync(dbPath, 0o400);

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

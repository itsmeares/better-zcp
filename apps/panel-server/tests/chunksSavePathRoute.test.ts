import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.ts";


const getRoleByName = vi.fn(async (name) =>
  name === "chunks_manage_only"
    ? { capabilities: ["chunks.manage"] }
    : mockGetRoleByName(name),
);

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  updateServer: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(async () => null),
  getRoleByName,
}));

const { getActiveServer, updateServer, setSetting, getSetting } = await import("../database/init.ts");
const { default: router } = await import("../routes/chunks.ts");

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

function postSavePath(body, role = "technician") {
  return runRoute("/save-path", "post", { user: { role }, body });
}

describe("POST /save-path", () => {
  let zomboidDir;
  const envName = "ZCP_CHUNKS_PATH_ORACLE_TEST";
  let previousEnvValue;

  beforeEach(() => {
    getActiveServer.mockReset();
    updateServer.mockReset().mockResolvedValue({ id: "srv-1" });
    setSetting.mockReset().mockResolvedValue(undefined);
    getSetting.mockReset().mockResolvedValue(null);
    getRoleByName.mockClear();
    zomboidDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-savepath-Zomboid-"));
    previousEnvValue = process.env[envName];
  });

  afterEach(() => {
    fs.rmSync(zomboidDir, { recursive: true, force: true });
    if (previousEnvValue === undefined) delete process.env[envName];
    else process.env[envName] = previousEnvValue;
  });

  describe("input validation, before any path even touches disk", () => {
    it("missing path -> 400 CHUNKS_SAVE_PATH_MISSING", async () => {
      const res = await postSavePath({});
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_MISSING" });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("non-string path -> 400 CHUNKS_SAVE_PATH_MISSING, not a type coercion attempt", async () => {
      const res = await postSavePath({ path: 12345 });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_MISSING" });
    });

    it("a quote-only path collapses to empty after normalization -> 400 CHUNKS_SAVE_PATH_EMPTY, not CHUNKS_SAVE_PATH_MISSING (this exercises the validated-but-empty branch, distinct from the raw-empty check above)", async () => {
      const res = await postSavePath({ path: '""' });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_EMPTY" });
    });
  });

  describe("filesystem validation -- resolveCustomOrDefaultDataPath's rejections propagate with their own statusCode and details", () => {
    it("a path that does not exist on disk -> 400, rejection.reason 'not-found'", async () => {
      const missing = path.join(zomboidDir, "does-not-exist");
      const res = await postSavePath({ path: missing });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().rejection).toMatchObject({ reason: "not-found" });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("never echoes an expanded environment secret in a rejection", async () => {
      const secret = "/srv/private/jwt-secret-value";
      process.env[envName] = secret;
      const rawPath = `%${envName}%/missing`;

      const res = await postSavePath({ path: rawPath });

      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().error).toContain(rawPath);
      expect(res.getBody().error).not.toContain(secret);
      expect(res.getBody().rejection).toMatchObject({
        reason: "not-found",
        tried: rawPath,
      });
    });

    it("a path that exists but is a FILE, not a directory -> 400, rejection.reason 'not-a-directory'", async () => {
      const filePath = path.join(zomboidDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "x");
      const res = await postSavePath({ path: filePath });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().rejection).toMatchObject({ reason: "not-a-directory" });
    });

    it("a real directory with no Zomboid markers at all -> 403 (not 400 -- distinct from the filesystem-shape rejections above), rejection.reason 'no-zomboid-markers'", async () => {
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-save-folder-"));
      try {
        const res = await postSavePath({ path: plainDir });
        expect(res.getStatusCode()).toBe(403);
        expect(res.getBody().rejection).toMatchObject({ reason: "no-zomboid-markers" });
      } finally {
        fs.rmSync(plainDir, { recursive: true, force: true });
      }
    });
  });

  describe("a valid path is persisted to the right place", () => {
    it("an active server with an id -> updateServer(id, {zomboidDataPath}), never touches the legacy setting", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", name: "Main" });
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({
        ok: true,
        target: "server",
        serverId: "srv-1",
        path: path.resolve(zomboidDir),
      });
      expect(updateServer).toHaveBeenCalledWith("srv-1", {
        zomboidDataPath: path.resolve(zomboidDir),
      });
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("no active server at all -> setSetting('zomboidDataPath', ...), never calls updateServer", async () => {
      getActiveServer.mockResolvedValue(null);
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({
        ok: true,
        target: "setting",
        path: path.resolve(zomboidDir),
      });
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", path.resolve(zomboidDir));
      expect(updateServer).not.toHaveBeenCalled();
    });

    it("an active server row that exists but has no id -> falls back to the legacy setting, same as no active server at all", async () => {
      getActiveServer.mockResolvedValue({ name: "Ghost", id: null });
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({ ok: true, target: "setting" });
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", path.resolve(zomboidDir));
      expect(updateServer).not.toHaveBeenCalled();
    });
  });

  it("active server vanishes between lookup and write -> 404, not a false ok:true", async () => {
    getActiveServer.mockResolvedValue({ id: "srv-1", name: "Main" });
    updateServer.mockResolvedValueOnce(null);
    const res = await postSavePath({ path: zomboidDir });

    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().ok).not.toBe(true);
    expect(updateServer).toHaveBeenCalledWith("srv-1", {
      zomboidDataPath: path.resolve(zomboidDir),
    });
  });

  it("an unexpected error while persisting -> 500 with a sanitized message, not a raw stack leak", async () => {
    getActiveServer.mockResolvedValue({ id: "srv-1" });
    updateServer.mockRejectedValue(new Error("disk full: /var/lib/panel/data.db"));
    const res = await postSavePath({ path: zomboidDir });

    expect(res.getStatusCode()).toBe(500);
    expect(res.getBody().error).toBeTruthy();
  });

  describe("server.configure required in addition to chunks.manage, enforced on CHANGE not presence", () => {
    it("chunks.manage alone is refused when the path would actually change the active server's stored value", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", zomboidDataPath: "/old/path" });
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toMatchObject({
        code: "CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED",
      });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("chunks.manage alone is refused when there is no active server and the legacy setting would change", async () => {
      getActiveServer.mockResolvedValue(null);
      getSetting.mockResolvedValue("/old/legacy/path");
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toMatchObject({
        code: "CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED",
      });
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("chunks.manage + server.configure succeeds at repointing the active server", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", zomboidDataPath: "/old/path" });
      const res = await postSavePath({ path: zomboidDir }, "technician");

      expect(res.getStatusCode()).toBe(200);
      expect(updateServer).toHaveBeenCalledWith("srv-1", {
        zomboidDataPath: path.resolve(zomboidDir),
      });
    });

    it("re-submitting the path already in effect needs nothing beyond chunks.manage -- no false 403 on an unchanged save", async () => {
      const resolved = path.resolve(zomboidDir);
      getActiveServer.mockResolvedValue({ id: "srv-1", zomboidDataPath: resolved });
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(200);
      expect(updateServer).toHaveBeenCalledWith("srv-1", { zomboidDataPath: resolved });
    });

    it("re-submitting the current legacy-setting value (no active server) also needs nothing beyond chunks.manage", async () => {
      const resolved = path.resolve(zomboidDir);
      getActiveServer.mockResolvedValue(null);
      getSetting.mockResolvedValue(resolved);
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(200);
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", resolved);
    });
  });
});

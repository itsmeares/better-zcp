import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.ts");

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

function postRestore(filename) {
  return runRoute("/restore/:filename", "post", { params: { filename } });
}

const SERVER_NAME = "servertest";
let configDir;
let parentDir;
let backupDir;

beforeEach(() => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-traversal-"));
  configDir = path.join(parentDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  backupDir = path.join(configDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(parentDir, { recursive: true, force: true });
});

describe("POST /restore/:filename -- originalName must be rejected when it resolves to '.' or '..'", () => {
  it("a crafted '....bak' backup (originalName strips to '..') is rejected, not restored", async () => {
    fs.writeFileSync(path.join(backupDir, "....bak"), "MALICIOUS-PARENT-OVERWRITE");
    const sentinelPath = path.join(parentDir, "sentinel.txt");
    fs.writeFileSync(sentinelPath, "untouched");

    const res = await postRestore("....bak");

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("RESTORE_INVALID_ORIGINAL_NAME");
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("untouched");
  });

  it("a bare '.' equivalent ('...bak', originalName strips to '.') is also rejected", async () => {
    fs.writeFileSync(path.join(backupDir, "...bak"), "MALICIOUS-SELF-OVERWRITE");
    const res = await postRestore("...bak");
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("RESTORE_INVALID_ORIGINAL_NAME");
  });

  it("legitimate restore is unaffected by the fix -- normal '<name>.<timestamp>.bak' still restores", async () => {
    const targetFile = path.join(configDir, `${SERVER_NAME}.ini`);
    fs.writeFileSync(targetFile, "OLD-CONTENT");
    const backupName = `${SERVER_NAME}.ini.2026-08-31T12-00-00.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), "RESTORED-CONTENT");

    const res = await postRestore(backupName);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()?.success).toBe(true);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("RESTORED-CONTENT");
  });
});

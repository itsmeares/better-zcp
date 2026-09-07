import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.ts";


const getActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({
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

const SERVER_NAME = "TestIni";
let configDir;
let iniPath;

function putIni(settings) {
  return runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });
}

function putRaw(content) {
  return runRoute("/raw/:type", "put", {
    user: { role: "admin" },
    params: { type: "ini" },
    body: { content },
  });
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-dup-guard-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("PUT /server-files/ini -- refuses a structured save while a duplicate key exists on disk", () => {
  it("refuses even a save that never touches the duplicated key, and does not write anything", async () => {
    fs.writeFileSync(
      iniPath,
      ["PVP=true", "PublicName=First", "DefaultPort=16261", "PublicName=Second", ""].join("\n"),
    );

    const res = await putIni({ PVP: "false" });

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().code).toBe("INI_DUPLICATE_KEY_BLOCKS_STRUCTURED_SAVE");
    expect(res.getBody().duplicateKeys).toEqual([{ key: "PublicName", count: 2 }]);
    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toContain("PublicName=First");
    expect(onDisk).toContain("PublicName=Second");
    expect(onDisk).toContain("PVP=true");
  });

  it("succeeds once the duplicate is gone", async () => {
    fs.writeFileSync(iniPath, ["PVP=true", "PublicName=Second", ""].join("\n"));

    const res = await putIni({ PVP: "false" });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=false");
  });

  it("still saves normally when the file has no duplicate keys at all", async () => {
    fs.writeFileSync(iniPath, "PVP=true\n");

    const res = await putIni({ PVP: "false" });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PVP=false");
  });

  it("the raw tab remains a real escape hatch: PUT /raw/ini still writes byte-for-byte while a duplicate exists", async () => {
    fs.writeFileSync(
      iniPath,
      ["PVP=true", "PublicName=First", "PublicName=Second", ""].join("\n"),
    );

    const fixed = ["PVP=true", "PublicName=Second", ""].join("\n");
    const res = await putRaw(fixed);

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe(fixed);
  });
});

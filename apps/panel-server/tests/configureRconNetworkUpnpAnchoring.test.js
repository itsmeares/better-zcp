import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.ts", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../routes/chunks.ts", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router, applyUpnpToIni } = await import("../routes/server.js");
const { getActiveServer } = await import("../database/init.ts");

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function fakeReq(body, io = { emit: vi.fn() }) {
  return { app: { get: () => io }, body };
}

let root;
let serverConfigPath;
let iniPath;
const welcomeLine =
  'ServerWelcomeMessage="RCONPassword=notthepassword UPnP=false DefaultPort=9999 UDPPort=9999 are all decoys, ignore them."';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-configure-anchor-"));
  serverConfigPath = path.join(root, "Server");
  fs.mkdirSync(serverConfigPath, { recursive: true });
  iniPath = path.join(serverConfigPath, "servertest.ini");
  fs.writeFileSync(
    iniPath,
    `PVP=false\n${welcomeLine}\nRCONPassword=old\nRCONPort=27015\nUPnP=true\nDefaultPort=16261\nUDPPort=16262\n`,
    "utf-8",
  );
  getActiveServer.mockResolvedValue({ serverConfigPath, serverName: "servertest" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  getActiveServer.mockReset();
});

describe("POST /configure-rcon leaves a free-text RCONPassword=/RCONPort= collision untouched", () => {
  it("updates the real RCON lines, not the welcome message", async () => {
    const handler = getHandler("/configure-rcon");
    const response = createResponse();

    await handler(
      fakeReq({ rconPassword: "brand-new-secret", rconPort: 27020 }),
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("RCONPassword=brand-new-secret");
    expect(content).toContain("RCONPort=27020");
    expect(content.match(/^RCONPassword=/gm)).toHaveLength(1);
    expect(content.match(/^RCONPort=/gm)).toHaveLength(1);
  });
});

describe("POST /configure-network leaves a free-text DefaultPort=/UDPPort=/UPnP= collision untouched", () => {
  it("updates the real port + UPnP lines, not the welcome message", async () => {
    const handler = getHandler("/configure-network");
    const response = createResponse();

    await handler(fakeReq({ serverPort: 17000, useUpnp: false }), response);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("DefaultPort=17000");
    expect(content).toContain("UDPPort=17001");
    expect(content).toContain("UPnP=false");
    expect(content.match(/^DefaultPort=/gm)).toHaveLength(1);
    expect(content.match(/^UDPPort=/gm)).toHaveLength(1);
    expect(content.match(/^UPnP=/gm)).toHaveLength(1);
  });
});

describe("applyUpnpToIni() leaves a free-text UPnP= collision untouched", () => {
  it("updates the real UPnP line, not the welcome message", async () => {
    const result = await applyUpnpToIni(serverConfigPath, "servertest", false);
    expect(result).toEqual({ applied: true });

    const content = fs.readFileSync(iniPath, "utf-8");
    expect(content).toContain(welcomeLine);
    expect(content).toContain("UPnP=false");
    expect(content.match(/^UPnP=/gm)).toHaveLength(1);
  });
});

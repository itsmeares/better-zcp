import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.ts");
const { default: router } = await import("../routes/mods.ts");

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

describe("mod load order preservation for numeric-shaped mod IDs", () => {
  let dataRoot;
  let iniPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-save-order-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(
      iniPath,
      "Mods=AlphaMod;3519629457;BetaMod\nWorkshopItems=1111111111;3519629457\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /save-order preserves a numeric mod ID through a reorder instead of silently dropping it", async () => {
    const res = await runRoute("/save-order", "post", {
      body: { modIds: ["BetaMod", "3519629457", "AlphaMod"] },
    });

    expect(res.getStatusCode()).toBe(200);

    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1] || "";
    const ids = modsLine.split(";").filter(Boolean);

    expect(ids).toEqual(["BetaMod", "3519629457", "AlphaMod"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const getActiveServer = vi.fn();
const getSetting = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.ts", () => ({
  getActiveServer: (...args: unknown[]) => getActiveServer(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
}));
vi.mock("../services/rcon.ts", () => ({
  resolveEnvRconHost: () => "127.0.0.1",
}));

const { default: router } = await import("../routes/server.ts");

async function execute(routePath: string, method: string, data: Record<string, unknown> = {}) {
  const handler = router.stack.find((entry) =>
    entry.route?.path === routePath && entry.route.methods[method],
  )?.route?.stack.at(-1)?.handle;
  if (!handler) throw new Error(`Missing route ${method} ${routePath}`);
  const response = {
    statusCode: 200,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  await handler({
    body: data,
    query: data,
    app: { get: () => undefined },
  } as any, response as any, () => {});
  return response;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "better-zcp-node-routes-"));
  getActiveServer.mockReset().mockResolvedValue(null);
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("server API routes", () => {
  it("checks SteamCMD without accepting traversal paths", async () => {
    const executableName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(root, executableName), "");
    expect((await execute("/steamcmd/check", "get", { path: `${root}/..` })).body)
      .toEqual({ exists: false, message: "Invalid path" });
    expect((await execute("/steamcmd/check", "get", { path: root })).body)
      .toEqual({
        exists: true,
        path: root,
        executable: path.join(root, executableName),
        message: "SteamCMD found",
      });
  });

  it("filters and clears console logs, streams additions, and counts errors", async () => {
    getActiveServer.mockResolvedValue({ zomboidDataPath: root });
    const logPath = path.join(root, "server-console.txt");
    const initialLog = [
      "SERVER STARTED",
      "ordinary line",
      "IsoSpriteManager.AddSprite > duplicate texture",
      "ERROR[server] broken",
    ].join("\n");
    fs.writeFileSync(logPath, initialLog);
    expect((await execute("/console-log", "get", { lines: "10", filter: "filtered" })).body)
      .toMatchObject({
        lines: ["SERVER STARTED", "ordinary line", "ERROR[server] broken"],
        filteredCount: 3,
        filterLevel: "filtered",
      });
    expect((await execute("/console-log/error-count", "get")).body)
      .toMatchObject({ count: 1, sinceStart: true });
    fs.appendFileSync(logPath, "\nRCON: connected");
    expect((await execute("/console-log/stream", "get", {
      lastSize: String(Buffer.byteLength(initialLog)),
      filter: "important",
    })).body).toMatchObject({ newLines: ["RCON: connected"] });
    expect((await execute("/console-log/clear", "post")).body).toEqual({ success: true });
    expect(fs.readFileSync(logPath, "utf8")).toBe("");
  });

  it("writes RCON settings through the locked INI writer", async () => {
    const configPath = path.join(root, "Server");
    fs.mkdirSync(configPath);
    const iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(iniPath, "DefaultPort=16261\nRCONPassword=old\n");
    getActiveServer.mockResolvedValue({ serverConfigPath: configPath, serverName: "TestServer" });
    const result = await execute("/configure-rcon", "post", {
      rconPassword: "new",
      rconPort: "27016",
    });
    expect(result.body).toMatchObject({ success: true, iniPath });
    expect(fs.readFileSync(iniPath, "utf8")).toContain("RCONPassword=new");
    expect(fs.readFileSync(iniPath, "utf8")).toContain("RCONPort=27016");
    expect(setSetting).toHaveBeenCalledWith("rconPort", 27016);
  });

  it("returns 503 when the update checker is unavailable", async () => {
    const result = await execute("/update-check/status", "get");
    expect(result.statusCode).toBe(503);
    expect(result.body.code).toBe("UPDATE_CHECKER_NOT_AVAILABLE");
  });
});

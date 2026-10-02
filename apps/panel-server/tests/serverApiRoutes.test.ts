import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const getCurrentServer = vi.fn();
const getSetting = vi.fn();
const setSetting = vi.fn();
const updateServerProfile = vi.fn();

vi.mock("../database/init.ts", () => ({
  getCurrentServer: (...args: unknown[]) => getCurrentServer(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
}));
vi.mock("../services/rcon.ts", () => ({
  resolveEnvRconHost: () => "127.0.0.1",
}));
vi.mock("../services/serverProfiles.ts", () => ({ updateServerProfile }));

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
  getCurrentServer.mockReset().mockResolvedValue(null);
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
  updateServerProfile.mockReset().mockResolvedValue({});
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("server API routes", () => {
  it.each(["/install", "/quick-setup"])("%s rejects invalid launch input before creating files", async route => {
    const installPath = path.join(root, "not-created");
    const result = await execute(route, "post", {
      installPath,
      steamcmdPath: root,
      serverName: "Fixture",
      adminPassword: "bad\necho INJECTED",
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ code: "STARTUP_ARGUMENT_INVALID" });
    expect(fs.existsSync(installPath)).toBe(false);
    expect(updateServerProfile).not.toHaveBeenCalled();
  });

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
    getCurrentServer.mockResolvedValue({ zomboidDataPath: root });
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
    const writer = fs.openSync(logPath, "r+");
    try {
      const originalInode = fs.fstatSync(writer).ino;
      expect((await execute("/console-log/clear", "post")).body).toEqual({ success: true });
      expect(fs.statSync(logPath).ino).toBe(originalInode);
      expect(fs.fstatSync(writer).size).toBe(0);
      fs.writeSync(writer, "active writer remains attached\n");
      expect((await execute("/console-log", "get")).body.content)
        .toContain("active writer remains attached");
    } finally {
      fs.closeSync(writer);
    }
    expect((await execute("/console-log/error-count", "get")).body)
      .toMatchObject({ count: 0 });
  });

  it("keeps console logs and cached error counts on the selected profile", async () => {
    const secondPath = path.join(root, "second");
    fs.mkdirSync(secondPath);
    fs.writeFileSync(path.join(root, "server-console.txt"), "ERROR[server] first\n");
    fs.writeFileSync(path.join(secondPath, "server-console.txt"), "ordinary line\n");
    getCurrentServer.mockResolvedValue({ zomboidDataPath: root });
    getSetting.mockResolvedValue(root);

    expect((await execute("/console-log/error-count", "get")).body)
      .toMatchObject({ count: 1 });
    getCurrentServer.mockResolvedValue({ zomboidDataPath: secondPath });
    expect((await execute("/console-log/error-count", "get")).body)
      .toMatchObject({ count: 0 });
    expect((await execute("/console-log", "get", { filter: "all" })).body.path)
      .toBe(path.join(secondPath, "server-console.txt"));

    getCurrentServer.mockResolvedValue({ name: "unconfigured" });
    expect((await execute("/console-log", "get")).statusCode).toBe(400);
    expect((await execute("/console-log/clear", "post")).statusCode).toBe(400);
    expect(fs.readFileSync(path.join(root, "server-console.txt"), "utf8"))
      .toContain("ERROR[server] first");
  });

  it.skipIf(process.platform === "win32")("refuses linked console logs on every read and clear route without changing the target", async () => {
    getCurrentServer.mockResolvedValue({ zomboidDataPath: root });
    const target = path.join(root, "panel.sqlite");
    fs.writeFileSync(target, "PRIVATE-PANEL-FIXTURE");
    fs.symlinkSync(target, path.join(root, "server-console.txt"));

    for (const [route, method] of [
      ["/console-log", "get"], ["/console-log/error-count", "get"],
      ["/console-log/stream", "get"], ["/console-log/clear", "post"],
    ]) {
      expect((await execute(route, method)).statusCode).toBe(500);
    }
    expect(fs.readFileSync(target, "utf8")).toBe("PRIVATE-PANEL-FIXTURE");
    expect(fs.lstatSync(path.join(root, "server-console.txt")).isSymbolicLink()).toBe(true);
  });

  it("writes RCON settings through the locked INI writer", async () => {
    const configPath = path.join(root, "Server");
    fs.mkdirSync(configPath);
    const iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(iniPath, "DefaultPort=16261\nRCONPassword=old\n");
    getCurrentServer.mockResolvedValue({ id: "server-1", serverConfigPath: configPath, serverName: "TestServer" });
    const result = await execute("/configure-rcon", "post", {
      rconPassword: "new",
      rconPort: "27016",
    });
    expect(result.body).toMatchObject({ success: true, iniPath });
    expect(fs.readFileSync(iniPath, "utf8")).toContain("RCONPassword=new");
    expect(fs.readFileSync(iniPath, "utf8")).toContain("RCONPort=27016");
    expect(updateServerProfile).toHaveBeenCalledWith("server-1", {
      rconPassword: "new",
      rconPort: 27016,
      rconHost: "127.0.0.1",
    }, expect.any(Object));
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not configure an old server when the selected profile has no config path", async () => {
    const configPath = path.join(root, "Server");
    fs.mkdirSync(configPath);
    const iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(iniPath, "RCONPassword=old\n");
    getCurrentServer.mockResolvedValue({ name: "new", serverName: "NewServer" });
    getSetting.mockImplementation(async (key: string) =>
      key === "serverConfigPath" ? configPath : "TestServer",
    );

    const result = await execute("/configure-rcon", "post", {
      rconPassword: "new",
      rconPort: 27016,
    });

    expect(result.statusCode).toBe(400);
    expect(fs.readFileSync(iniPath, "utf8")).toBe("RCONPassword=old\n");
    expect(setSetting).not.toHaveBeenCalled();
    expect(updateServerProfile).not.toHaveBeenCalled();
  });

  it("returns 503 when the update checker is unavailable", async () => {
    const result = await execute("/update-check/status", "get");
    expect(result.statusCode).toBe(503);
    expect(result.body.code).toBe("UPDATE_CHECKER_NOT_AVAILABLE");
  });
});

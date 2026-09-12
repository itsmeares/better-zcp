import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const getActiveServer = vi.fn();
const getSetting = vi.fn();
const setSetting = vi.fn();
const getPanelRuntime = vi.fn();

vi.mock("../database/init.ts", () => ({
  getActiveServer: (...args: unknown[]) => getActiveServer(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
}));

vi.mock("../services/rcon.ts", () => ({
  resolveEnvRconHost: () => "127.0.0.1",
}));

vi.mock("../utils/panelRuntime.ts", () => ({
  getPanelRuntime: (...args: unknown[]) => getPanelRuntime(...args),
}));

const {
  checkSteamCmd,
  configureRcon,
  getConsoleErrorCount,
  getConsoleLog,
  getConsoleLogStream,
  clearConsoleLog,
  getServerUpdateStatus,
} = await import("../../panel-client/src/lib/serverServerApi.server.ts");

type ServerFunction = {
  __executeImplementation: (data: Record<string, unknown>) => Promise<any>;
};

function execute(serverFunction: unknown, data: Record<string, unknown> = {}) {
  return (serverFunction as ServerFunction).__executeImplementation(data);
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "better-zcp-start-legacy-"));
  getActiveServer.mockReset().mockResolvedValue(null);
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
  getPanelRuntime.mockReset().mockReturnValue({ updateChecker: undefined });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Start legacy JSON implementations", () => {
  it("checks the platform SteamCMD executable without accepting traversal paths", async () => {
    const executableName =
      process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(root, executableName), "");

    await expect(
      execute(checkSteamCmd, { path: `${root}/..` }),
    ).resolves.toEqual({
      exists: false,
      message: "Invalid path",
    });
    await expect(execute(checkSteamCmd, { path: root })).resolves.toEqual({
      exists: true,
      path: root,
      executable: path.join(root, executableName),
      message: "SteamCMD found",
    });
  });

  it("preserves console filtering, incremental reads, error counts, and clearing", async () => {
    getActiveServer.mockResolvedValue({ zomboidDataPath: root });
    const logPath = path.join(root, "server-console.txt");
    const initialLog = [
      "SERVER STARTED",
      "ordinary line",
      "IsoSpriteManager.AddSprite > duplicate texture",
      "ERROR[server] broken",
    ].join("\n");
    fs.writeFileSync(logPath, initialLog);

    await expect(
      execute(getConsoleLog, { lines: "10", filter: "filtered" }),
    ).resolves.toEqual(
      expect.objectContaining({
        lines: ["SERVER STARTED", "ordinary line", "ERROR[server] broken"],
        filteredCount: 3,
        filterLevel: "filtered",
      }),
    );
    await expect(execute(getConsoleErrorCount)).resolves.toEqual(
      expect.objectContaining({ count: 1, sinceStart: true }),
    );

    const appended = "\nRCON: connected";
    fs.appendFileSync(logPath, appended);
    const lastSize = Buffer.byteLength(initialLog);
    await expect(
      execute(getConsoleLogStream, {
        lastSize: String(lastSize),
        filter: "important",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ newLines: ["RCON: connected"] }),
    );

    await expect(execute(clearConsoleLog)).resolves.toEqual({ success: true });
    expect(fs.readFileSync(logPath, "utf-8")).toBe("");
  });

  it("writes RCON settings through the shared locked INI writer", async () => {
    const configPath = path.join(root, "Server");
    fs.mkdirSync(configPath);
    const iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(iniPath, "DefaultPort=16261\nRCONPassword=old\n");
    getActiveServer.mockResolvedValue({
      serverConfigPath: configPath,
      serverName: "TestServer",
    });

    await expect(
      execute(configureRcon, { rconPassword: "new", rconPort: "27016" }),
    ).resolves.toEqual(expect.objectContaining({ success: true, iniPath }));
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("RCONPassword=new");
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("RCONPort=27016");
    expect(setSetting).toHaveBeenCalledWith("rconPort", 27016);
  });

  it("keeps the legacy 503 when the update checker is unavailable", async () => {
    await expect(execute(getServerUpdateStatus)).rejects.toMatchObject({
      status: 503,
      code: "UPDATE_CHECKER_NOT_AVAILABLE",
    });
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ServerManager } from "../services/serverManager.js";


function makeManager(savePath, serverName) {
  const manager = new ServerManager();
  Object.assign(manager, { savePath, serverName });
  return manager;
}

describe("ServerManager.saveServerConfig() -- write is verified by reading it back", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-saveconfig-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("succeeds and the file on disk really does contain the new value (happy path)", async () => {
    const manager = makeManager(tmpRoot, "TestServer");
    const iniPath = path.join(tmpRoot, "TestServer.ini");
    fs.writeFileSync(iniPath, "PVP=false\nMaxPlayers=16\n", "utf-8");

    const result = await manager.saveServerConfig({ PVP: "true" });

    expect(result.success).toBe(true);
    const onDisk = fs.readFileSync(iniPath, "utf-8");
    expect(onDisk).toMatch(/PVP=true/);
    expect(onDisk).toMatch(/MaxPlayers=16/);
  });

  it("throws instead of reporting success when the file on disk doesn't match what was intended", async () => {
    const manager = makeManager(tmpRoot, "TestServer");
    const iniPath = path.join(tmpRoot, "TestServer.ini");
    fs.writeFileSync(iniPath, "PVP=false\n", "utf-8");

    const realReadFileSync = fs.readFileSync.bind(fs);
    let readCount = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
      readCount += 1;
      if (readCount === 2) return "PVP=false\n";
      return realReadFileSync(p, enc);
    });

    await expect(
      manager.saveServerConfig({ PVP: "true" }),
    ).rejects.toThrow(/verification failed/i);
  });
});

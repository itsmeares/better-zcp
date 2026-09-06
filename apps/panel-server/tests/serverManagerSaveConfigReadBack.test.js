import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ServerManager } from "../services/serverManager.js";

// 2026-09-03, serverManager.js sweep: saveServerConfig() wrote the .ini via
// writeFileAtomic() and returned {success:true} on nothing more than "the
// write call didn't throw" -- the exact "succeeded but did nothing" shape
// this sweep was dispatched to hunt, and one of the two shapes the test identified
// specifically for this file. It has no production caller today (confirmed
// by grep, same as the pre-existing comment in the function already notes),
// but it's listed in scripts/eslint-rules/require-result-handling.js as a result
// callers must check, so closing the gap now means whoever wires it up
// later doesn't inherit a config write that reports success without having
// verified it landed.
//
// Fix: read the just-written file back inside the same lock and compare it
// byte-for-byte against the content that was supposed to be written.

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

    // Simulate writeFileAtomic() reporting success (no throw) while the file
    // that's actually readable back doesn't match -- a truncated write or a
    // wrong-encoding write are the real-world versions of this; forcing the
    // read-back call specifically to disagree is the deterministic way to
    // prove the NEW verification step is what's catching it, not some other
    // unrelated failure.
    const realReadFileSync = fs.readFileSync.bind(fs);
    let readCount = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
      readCount += 1;
      // 1st call: saveServerConfig's own "read existing content" step.
      // 2nd call: the new post-write verification read-back -- corrupt it.
      if (readCount === 2) return "PVP=false\n";
      return realReadFileSync(p, enc);
    });

    await expect(
      manager.saveServerConfig({ PVP: "true" }),
    ).rejects.toThrow(/verification failed/i);
  });
});

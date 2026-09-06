import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";


function makeDeadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

describe("acquireLock / releaseLock", () => {
  let dataDir;
  let killSpy;
  let acquireLock;
  let releaseLock;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-pidlock-"));
    vi.resetModules();
    ({ acquireLock, releaseLock } = await import("../utils/pidLock.js"));
  });

  afterEach(() => {
    killSpy?.mockRestore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("acquires the lock when no lock file exists yet, and writes this process's own pid into it", () => {
    const result = acquireLock(dataDir);
    expect(result.acquired).toBe(true);
    expect(fs.readFileSync(result.lockPath, "utf8")).toBe(String(process.pid));
  });

  it("acquires the lock when the existing lock file names this SAME process's pid (re-entrant start)", () => {
    fs.writeFileSync(path.join(dataDir, "panel.lock"), String(process.pid));
    const result = acquireLock(dataDir);
    expect(result.acquired).toBe(true);
  });

  it("acquires the lock when the existing lock file's pid is CONFIRMED dead (ESRCH) -- a stale lock is silently replaced", () => {
    const deadPid = makeDeadPid();
    fs.writeFileSync(path.join(dataDir, "panel.lock"), String(deadPid));

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(true);
    expect(fs.readFileSync(result.lockPath, "utf8")).toBe(String(process.pid));
  });

  it("refuses to acquire when the existing lock file's pid is genuinely alive (no error at all from process.kill)", () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "424242");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(false);
    expect(result.existingPid).toBe(424242);
    expect(result.reason).toMatch(/already running/i);
  });

  it("REFUSES to acquire on an ambiguous process.kill() error (neither ESRCH nor EPERM) -- the direction the old code got backwards", () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("something unexpected");
      err.code = "EINVAL";
      throw err;
    });
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "424242");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(false);
    expect(result.existingPid).toBe(424242);
  });

  it("treats EPERM (exists, just not owned by us) as alive -- refuses to acquire", () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("Operation not permitted");
      err.code = "EPERM";
      throw err;
    });
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "424242");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(false);
  });

  it("ignores a lock file whose content isn't a positive integer pid, and proceeds", () => {
    fs.writeFileSync(path.join(dataDir, "panel.lock"), "not-a-pid");

    const result = acquireLock(dataDir);

    expect(result.acquired).toBe(true);
  });

  it("releaseLock() removes the lock file this process created", () => {
    const result = acquireLock(dataDir);
    expect(fs.existsSync(result.lockPath)).toBe(true);

    releaseLock();

    expect(fs.existsSync(result.lockPath)).toBe(false);
  });

  it("releaseLock() does NOT remove a lock file that no longer contains our pid (another instance took over)", () => {
    const result = acquireLock(dataDir);
    fs.writeFileSync(result.lockPath, "999999");

    releaseLock();

    expect(fs.existsSync(result.lockPath)).toBe(true);
    expect(fs.readFileSync(result.lockPath, "utf8")).toBe("999999");
  });
});

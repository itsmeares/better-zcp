import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { writeFileAtomic } = await import("../utils/fileWriteQueue.js");

function eperm() {
  const err = new Error("EPERM: operation not permitted, rename");
  err.code = "EPERM";
  return err;
}

function enoent() {
  const err = new Error("ENOENT: no such file or directory, rename");
  err.code = "ENOENT";
  return err;
}

describe("writeFileAtomic: bounded retry on transient Windows rename errors", () => {
  let dir;
  let targetPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-write-atomic-"));
    targetPath = path.join(dir, "config.ini");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function listTmpFiles() {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  }

  it("retries a rename that fails twice with a transient error, then succeeds", () => {
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      calls++;
      if (calls <= 2) throw eperm();
      return realRename(...args);
    });

    writeFileAtomic(targetPath, "content-survives-the-retry");

    expect(spy).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("content-survives-the-retry");
    expect(listTmpFiles()).toEqual([]);
  });

  it("fails fast on a non-transient error, without retrying or delaying", () => {
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw enoent();
    });

    expect(() => writeFileAtomic(targetPath, "x")).toThrow(/ENOENT/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(listTmpFiles()).toEqual([]);
  });

  it("gives up after exhausting retries on a persistent transient error, and still cleans up the tmp file", () => {
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw eperm();
    });

    expect(() => writeFileAtomic(targetPath, "x")).toThrow(/EPERM/);
    // Bounded to a fixed, small number of attempts (1 initial + 3 retries),
    // not unbounded spinning.
    expect(spy).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(listTmpFiles()).toEqual([]);
  });

  it("still writes successfully on the very first attempt when nothing fails (no regression on the happy path)", () => {
    writeFileAtomic(targetPath, "plain-write");
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("plain-write");
    expect(listTmpFiles()).toEqual([]);
  });
});

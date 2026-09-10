import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLinuxWritableHomeEnv } from "../utils/steamEnvironment.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildLinuxWritableHomeEnv", () => {
  it("creates a private HOME under the writable application directory", () => {
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "steam-env-"));
    tempDirs.push(basePath);

    const env = buildLinuxWritableHomeEnv(basePath, {
      PATH: "/usr/bin",
      KEEP: "yes",
    });
    const expectedHome = path.join(basePath, ".steamhome");

    expect(env.HOME).toBe(expectedHome);
    expect(env.KEEP).toBe("yes");
    expect(fs.statSync(expectedHome).isDirectory()).toBe(true);
    expect(fs.statSync(expectedHome).mode & 0o777).toBe(0o700);
  });
});

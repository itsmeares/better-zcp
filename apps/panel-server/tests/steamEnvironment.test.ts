import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLinuxWritableHomeEnv } from "../utils/steamEnvironment.ts";
import { getDataPaths } from "../utils/paths.ts";

const tempDirs: string[] = [];
const tempHomes: string[] = [];

afterEach(() => {
  for (const dir of tempHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildLinuxWritableHomeEnv", () => {
  it("creates a private HOME under the application data root", () => {
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "steam-env-"));
    tempDirs.push(basePath);

    const env = buildLinuxWritableHomeEnv(basePath, {
      PATH: "/usr/bin",
      KEEP: "yes",
    });
    const expectedRoot = path.join(getDataPaths().dataDir, "steam-homes");
    tempHomes.push(env.HOME!);

    expect(env.HOME!.startsWith(`${expectedRoot}${path.sep}`)).toBe(true);
    expect(env.KEEP).toBe("yes");
    expect(fs.statSync(env.HOME!).isDirectory()).toBe(true);
    expect(fs.statSync(env.HOME!).mode & 0o777).toBe(0o700);

    const otherBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "steam-env-other-"));
    tempDirs.push(otherBasePath);
    const otherEnv = buildLinuxWritableHomeEnv(otherBasePath);
    tempHomes.push(otherEnv.HOME!);
    expect(otherEnv.HOME).not.toBe(env.HOME);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  probeInstallPath,
  probeDataPath,
  findDataPath,
  discoverMounts,
  discoverMountIssues,
  readServerIniSettings,
} from "../services/mountDiscovery.js";
import { isContainerized } from "../utils/dockerDetect.js";

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-mount-discovery-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("probeInstallPath", () => {
  it("rejects a missing or non-directory path", () => {
    expect(probeInstallPath(path.join(tmpRoot, "nope")).valid).toBe(false);
    expect(probeInstallPath("").valid).toBe(false);
  });

  it("rejects an unrelated empty directory", () => {
    expect(probeInstallPath(tmpRoot).valid).toBe(false);
  });

  it("distinguishes permission-denied from genuinely missing", () => {
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw denied;
    });

    const result = probeInstallPath(path.join(tmpRoot, "locked"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("permission-denied");
  });

  it("reports no reason for a genuinely missing path", () => {
    const result = probeInstallPath(path.join(tmpRoot, "nope"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("detects a ProjectZomboid64 binary as a PZ signature", () => {
    fs.writeFileSync(path.join(tmpRoot, "ProjectZomboid64"), "");
    expect(probeInstallPath(tmpRoot).valid).toBe(true);
  });

  it("detects start-server.sh as a PZ signature", () => {
    fs.writeFileSync(path.join(tmpRoot, "start-server.sh"), "#!/bin/sh\n");
    const result = probeInstallPath(tmpRoot);
    expect(result.valid).toBe(true);
    expect(result.hasStartScript).toBe(true);
  });

  it("detects media/lua/ and steamapps/ as PZ signatures", () => {
    fs.mkdirSync(path.join(tmpRoot, "media", "lua"), { recursive: true });
    expect(probeInstallPath(tmpRoot).valid).toBe(true);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "pz-mount-discovery-"));
    fs.mkdirSync(path.join(other, "steamapps"), { recursive: true });
    expect(probeInstallPath(other).valid).toBe(true);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("reports the bundled PanelBridge mod when present", () => {
    fs.writeFileSync(path.join(tmpRoot, "start-server.sh"), "");
    fs.mkdirSync(path.join(tmpRoot, "media", "lua", "server"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpRoot, "media", "lua", "server", "PanelBridge.lua"),
      "",
    );
    expect(probeInstallPath(tmpRoot).hasPanelBridge).toBe(true);
  });
});

describe("probeDataPath", () => {
  it("rejects a missing path", () => {
    const result = probeDataPath(path.join(tmpRoot, "nope"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("distinguishes permission-denied from genuinely missing", () => {
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw denied;
    });

    const result = probeDataPath(path.join(tmpRoot, "locked"));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("permission-denied");
  });

  it("rejects a directory with no PZ data markers", () => {
    expect(probeDataPath(tmpRoot).valid).toBe(false);
  });

  it("accepts a folder with Saves/ or Lua/", () => {
    fs.mkdirSync(path.join(tmpRoot, "Saves"), { recursive: true });
    expect(probeDataPath(tmpRoot).valid).toBe(true);
  });

  it("reads server names from Server/*.ini, excluding sidecar files", () => {
    const serverDir = path.join(tmpRoot, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "servertest.ini"), "RCONPort=27015");
    fs.writeFileSync(path.join(serverDir, "servertest_SandboxVars.ini"), "");
    fs.writeFileSync(path.join(serverDir, "servertest_spawnpoints.ini"), "");

    const result = probeDataPath(tmpRoot);
    expect(result.valid).toBe(true);
    expect(result.serverNames).toEqual(["servertest"]);
  });
});

describe("findDataPath", () => {
  it("finds a Zomboid subdirectory under the install path", () => {
    fs.mkdirSync(path.join(tmpRoot, "Zomboid"), { recursive: true });
    expect(findDataPath(tmpRoot)).toBe(path.join(tmpRoot, "Zomboid"));
  });

  it("returns null when no Zomboid subdirectory exists", () => {
    expect(findDataPath(tmpRoot)).toBe(null);
  });
});

describe("readServerIniSettings", () => {
  it("parses RCON/port/name settings from the discovered ini", () => {
    const serverDir = path.join(tmpRoot, "Server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, "servertest.ini"),
      ["RCONPort=27016", "RCONPassword=secret", "DefaultPort=16262", "PublicName=My Server"].join(
        "\n",
      ),
    );

    const settings = readServerIniSettings(tmpRoot, "servertest");
    expect(settings).toEqual({
      rconPort: 27016,
      rconPassword: "secret",
      serverPort: 16262,
      publicName: "My Server",
    });
  });

  it("returns null when the ini file does not exist", () => {
    expect(readServerIniSettings(tmpRoot, "missing")).toBe(null);
  });
});

describe("discoverMounts", () => {
  it("returns nothing when no candidate path is a valid PZ install", () => {
    expect(discoverMounts()).toEqual([]);
  });

  it("picks up an install path configured via PZ_SERVER_PATH / PZ_SAVE_PATH", () => {
    const installDir = path.join(tmpRoot, "install");
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "start-server.sh"), "");
    fs.mkdirSync(path.join(dataDir, "Saves"), { recursive: true });

    vi.stubEnv("PZ_SERVER_PATH", installDir);
    vi.stubEnv("PZ_SAVE_PATH", dataDir);

    const mounts = discoverMounts();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      installPath: installDir,
      dataPath: dataDir,
      source: "environment",
    });
  });

  it("falls back to a Zomboid subdirectory when no data path is configured", () => {
    const installDir = path.join(tmpRoot, "install");
    fs.mkdirSync(path.join(installDir, "Zomboid", "Saves"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(installDir, "start-server.sh"), "");

    vi.stubEnv("PZ_SERVER_PATH", installDir);

    const mounts = discoverMounts();
    expect(mounts).toHaveLength(1);
    expect(mounts[0].dataPath).toBe(path.join(installDir, "Zomboid"));
  });
});

describe("discoverMountIssues", () => {
  it("returns nothing when no common-mount candidate is even present", () => {
    expect(discoverMountIssues()).toEqual([]);
  });

  it("reports a common-mount install candidate that exists but can't be read", () => {
    const denied = new Error("EACCES: permission denied");
    denied.code = "EACCES";
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === "/pz-server") throw denied;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const issues = discoverMountIssues();
    expect(issues).toContainEqual({
      path: "/pz-server",
      source: "common-mount",
      reason: "permission-denied",
    });
  });

  it("does not report a candidate that simply isn't mounted", () => {
    // Default fs behaviour in the tmp-only test environment: nothing at the
    // hardcoded common-mount paths, which should be silent (not an issue).
    expect(discoverMountIssues()).toEqual([]);
  });
});

describe("isContainerized", () => {
  it("returns true when /.dockerenv exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => p === "/.dockerenv");
    expect(isContainerized()).toBe(true);
  });

  it("returns false with no dockerenv marker and no docker cgroup entry", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/\n");
    expect(isContainerized()).toBe(false);
  });

  it("falls back to a cgroup scan for docker/containerd markers", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/docker/abc123\n");
    expect(isContainerized()).toBe(true);
  });
});

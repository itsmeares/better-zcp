import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: beginRemoteConfigSession()'s freshness cache (MIRROR_FRESH_MS,
// 5s) was keyed only on serverName. A credential/host change on Settings
// followed by a config read/push within that window would reuse a mirror
// pulled under the PREVIOUS transport -- mismatched against the new one --
// because the cache had no way to tell the transport had changed.

const mockDataPaths = vi.hoisted(() => {
  const base = (process.env.TEMP || process.env.TMPDIR || "/tmp") + "/remote-config-freshness-test";
  return { dataDir: base + "/data", logsDir: base + "/logs" };
});
vi.mock("../utils/paths.js", () => ({ getDataPaths: () => mockDataPaths }));

const sftpInstances = vi.hoisted(() => ({ current: [] }));
vi.mock("ssh2-sftp-client", () => {
  return {
    default: vi.fn().mockImplementation(function () {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockRejectedValue(new Error("not found")), // every mirrored file "absent remotely"
        get: vi.fn(),
      };
      sftpInstances.current.push(instance);
      return instance;
    }),
  };
});

const { beginRemoteConfigSession, resetRemoteConfigSession } = await import(
  "../services/remoteConfigFiles.js"
);

const baseConfig = {
  host: "old-host.example.net",
  port: 22,
  username: "panel",
  password: "old-secret",
  configPath: "/home/pz/Server",
};

afterEach(() => {
  vi.clearAllMocks();
  sftpInstances.current = [];
  resetRemoteConfigSession();
  fs.rmSync(mockDataPaths.dataDir, { recursive: true, force: true });
});

describe("beginRemoteConfigSession transport-aware freshness", () => {
  it("re-pulls instead of reusing the cached mirror when host changes within the freshness window", async () => {
    await beginRemoteConfigSession(baseConfig, "servertest", { fresh: false });
    expect(sftpInstances.current).toHaveLength(1);

    const newHostConfig = { ...baseConfig, host: "new-host.example.net" };
    await beginRemoteConfigSession(newHostConfig, "servertest", { fresh: false });

    // Before the fix: this reused lastSession (same serverName, still within
    // MIRROR_FRESH_MS) without ever connecting to new-host -- a real pull
    // against the new transport never happened.
    expect(sftpInstances.current).toHaveLength(2);
  });

  it("re-pulls when only the username changes, same host/port/configPath", async () => {
    await beginRemoteConfigSession(baseConfig, "servertest", { fresh: false });
    expect(sftpInstances.current).toHaveLength(1);

    const newUserConfig = { ...baseConfig, username: "different-panel-user" };
    await beginRemoteConfigSession(newUserConfig, "servertest", { fresh: false });

    expect(sftpInstances.current).toHaveLength(2);
  });

  it("still reuses the cached mirror when nothing about the transport changed", async () => {
    await beginRemoteConfigSession(baseConfig, "servertest", { fresh: false });
    expect(sftpInstances.current).toHaveLength(1);

    // Same transport, just re-authenticating with a rotated password --
    // doesn't change which remote files this points at, so the cache should
    // still apply.
    const samePasswordRotated = { ...baseConfig, password: "new-secret" };
    await beginRemoteConfigSession(samePasswordRotated, "servertest", { fresh: false });

    expect(sftpInstances.current).toHaveLength(1);
  });
});

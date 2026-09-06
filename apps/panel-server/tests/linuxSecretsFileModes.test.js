import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockDataPaths = vi.hoisted(() => {
  const base =
    (process.env.TEMP || process.env.TMPDIR || "/tmp") + "/linux-secrets-modes-test";
  return { dataDir: base + "/data", logsDir: base + "/logs" };
});
vi.mock("../utils/paths.js", () => ({ getDataPaths: () => mockDataPaths }));

vi.mock("ssh2-sftp-client", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 28, isDirectory: false }),
      get: vi
        .fn()
        .mockResolvedValue(Buffer.from("RCONPassword=fake-remote-mirror-only\n")),
    };
  }),
}));

const { writeFileAtomic } = await import("../utils/fileWriteQueue.js");
const { loadOrCreateCerts, getCertPaths } = await import("../utils/certs.js");
const { pullRemoteConfigFiles } = await import("../services/remoteConfigFiles.js");

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

const isWindows = process.platform === "win32";

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(mockDataPaths.dataDir, { recursive: true, force: true });
});

describe("writeFileAtomic -- preserve-or-tighten mode across a rewrite", () => {
  it.skipIf(isWindows)(
    "a rewrite with no explicit mode never loosens an already-hardened target",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfa-mode-"));
      const target = path.join(root, "servertest.ini");
      fs.writeFileSync(target, "RCONPassword=fake-v1\n", { mode: 0o600 });
      expect(mode(target)).toBe(0o600);

      writeFileAtomic(target, "RCONPassword=fake-v2\n", "utf-8");

      expect(mode(target)).toBe(0o600);
      fs.rmSync(root, { recursive: true, force: true });
    },
  );

  it.skipIf(isWindows)(
    "a brand-new file with no explicit mode is unaffected -- same default as before this fix",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfa-mode-new-"));
      const target = path.join(root, "fresh.ini");
      const control = path.join(root, "control.ini");

      writeFileAtomic(target, "content", "utf-8");
      fs.writeFileSync(control, "content");

      expect(mode(target)).toBe(mode(control));
      fs.rmSync(root, { recursive: true, force: true });
    },
  );

  it.skipIf(isWindows)(
    "an explicit mode from the caller is always honoured outright, exactly as before this fix",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfa-mode-explicit-"));
      const target = path.join(root, "servertest.ini");
      fs.writeFileSync(target, "fake-v1", { mode: 0o644 });

      writeFileAtomic(target, "fake-v2", { encoding: "utf-8", mode: 0o600 });

      expect(mode(target)).toBe(0o600);
      fs.rmSync(root, { recursive: true, force: true });
    },
  );
});

describe("certs.js -- a regenerated key is tightened regardless of its prior mode", () => {
  it.skipIf(isWindows)(
    "CERT_DIR is 0700 and server.key stays 0600 even after a loose-mode-then-regenerate sequence",
    () => {
      loadOrCreateCerts();
      const { keyPath, certPath, certDir } = getCertPaths();
      expect(mode(certDir)).toBe(0o700);
      expect(mode(keyPath)).toBe(0o600);

      fs.chmodSync(keyPath, 0o644);
      fs.unlinkSync(certPath);
      loadOrCreateCerts();

      expect(mode(keyPath)).toBe(0o600);
    },
  );
});

describe("pullRemoteConfigFiles -- the local mirror of a remote server's config is hardened", () => {
  it.skipIf(isWindows)(
    "mirror directory is 0700 and each pulled file is 0600, regardless of process umask",
    async () => {
      const config = {
        host: "pz.example.net",
        port: 22,
        username: "panel",
        password: "fake-sftp-password-for-test-only",
        configPath: "/home/pz/Server",
      };

      const result = await pullRemoteConfigFiles(config, "servertest");

      expect(mode(result.mirrorDir)).toBe(0o700);
      const iniPath = path.join(result.mirrorDir, "servertest.ini");
      expect(fs.existsSync(iniPath)).toBe(true);
      expect(mode(iniPath)).toBe(0o600);
    },
  );
});

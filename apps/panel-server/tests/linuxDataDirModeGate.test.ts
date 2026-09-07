import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const originalConfigPathEnv = process.env.PANEL_PATHS_CONFIG_PATH;
const originalUmask = process.platform !== "win32" ? process.umask() : null;
const tempRoots = [];

afterEach(() => {
  if (process.platform !== "win32") process.umask(originalUmask);
  if (originalConfigPathEnv === undefined) {
    delete process.env.PANEL_PATHS_CONFIG_PATH;
  } else {
    process.env.PANEL_PATHS_CONFIG_PATH = originalConfigPathEnv;
  }
  vi.resetModules();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function freshPathsModule(dataDir, logsDir) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-datadir-mode-"));
  tempRoots.push(tempRoot);
  const configPath = path.join(tempRoot, "paths.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ dataDir, logsDir: logsDir || path.join(tempRoot, "logs") }),
  );
  process.env.PANEL_PATHS_CONFIG_PATH = configPath;
  vi.resetModules();
  return import("../utils/paths.ts");
}

function modeBits(dir) {
  return fs.statSync(dir).mode & 0o777;
}

describe("getDataPaths(): dataDir permission mode", () => {
  it.skipIf(process.platform === "win32")(
    "positive control: an unmanaged directory really can come out world-writable under umask 000 -- proves the stat probe below can detect a bad mode at all",
    () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-datadir-mode-control-"),
      );
      tempRoots.push(tempRoot);
      const dir = path.join(tempRoot, "unmanaged");
      process.umask(0o000);
      fs.mkdirSync(dir, { recursive: true });
      expect(modeBits(dir)).toBe(0o777);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fresh install, umask 000: dataDir is 0700, not the world-writable 0777 the bare mkdirSync would have produced",
    async () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-datadir-mode-fresh000-"),
      );
      tempRoots.push(tempRoot);
      const dataDir = path.join(tempRoot, "data");
      process.umask(0o000);
      const { getDataPaths } = await freshPathsModule(dataDir);
      getDataPaths();
      expect(modeBits(dataDir)).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fresh install, umask 022: dataDir is still 0700, not the umask-derived 0755",
    async () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-datadir-mode-fresh022-"),
      );
      tempRoots.push(tempRoot);
      const dataDir = path.join(tempRoot, "data");
      process.umask(0o022);
      const { getDataPaths } = await freshPathsModule(dataDir);
      getDataPaths();
      expect(modeBits(dataDir)).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "EXISTING install: a dataDir that already existed at a world-writable mode gets tightened on the next getDataPaths() call, not left alone",
    async () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-datadir-mode-existing-"),
      );
      tempRoots.push(tempRoot);
      const dataDir = path.join(tempRoot, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.chmodSync(dataDir, 0o777);
      expect(modeBits(dataDir)).toBe(0o777);

      const { getDataPaths } = await freshPathsModule(dataDir);
      getDataPaths();
      expect(modeBits(dataDir)).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not touch logsDir's mode (not a secret-bearing directory, out of this fix's scope)",
    async () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-datadir-mode-logs-"),
      );
      tempRoots.push(tempRoot);
      const dataDir = path.join(tempRoot, "data");
      const logsDir = path.join(tempRoot, "logs");
      process.umask(0o022);
      const { getDataPaths } = await freshPathsModule(dataDir, logsDir);
      getDataPaths();
      expect(modeBits(dataDir)).toBe(0o700);
      expect(modeBits(logsDir)).toBe(0o755);
    },
  );
});

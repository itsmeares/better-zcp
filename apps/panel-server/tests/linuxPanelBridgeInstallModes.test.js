import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLuaAtomic } from "../utils/embeddedLua.ts";

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

const isWindows = process.platform === "win32";
let root;
let originalUmask;

afterEach(() => {
  if (!isWindows && originalUmask !== undefined) process.umask(originalUmask);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("writeLuaAtomic -- mod file stays readable by a different user regardless of umask", () => {
  it.skipIf(isWindows)(
    "installed file is 0644 even under a hardened umask that would otherwise mask it to 0600",
    () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-mode-"));
      const targetDir = path.join(root, "media", "lua", "server");
      const targetPath = path.join(targetDir, "PanelBridge.lua");

      originalUmask = process.umask(0o077);
      try {
        writeLuaAtomic(targetPath, "-- fake mod content for test only\n");
      } finally {
        process.umask(originalUmask);
      }

      expect(mode(targetPath)).toBe(0o644);
      expect(mode(targetPath) & 0o004).toBe(0o004);
    },
  );

  it.skipIf(isWindows)(
    "a newly-created directory tree is 0755 (traversable by a different user) even under a hardened umask",
    () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-dirmode-"));
      const targetDir = path.join(root, "media", "lua", "server");
      const targetPath = path.join(targetDir, "PanelBridge.lua");

      originalUmask = process.umask(0o077);
      try {
        writeLuaAtomic(targetPath, "-- fake mod content for test only\n");
      } finally {
        process.umask(originalUmask);
      }

      expect(mode(path.join(root, "media"))).toBe(0o755);
      expect(mode(path.join(root, "media", "lua"))).toBe(0o755);
      expect(mode(targetDir)).toBe(0o755);
    },
  );

  it.skipIf(isWindows)(
    "an already-existing directory's mode is left untouched -- only newly created levels get the safe default",
    () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-preexist-"));
      const targetDir = path.join(root, "media", "lua", "server");
      const targetPath = path.join(targetDir, "PanelBridge.lua");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.chmodSync(targetDir, 0o750);

      writeLuaAtomic(targetPath, "-- fake mod content for test only\n");

      expect(mode(targetDir)).toBe(0o750);
      expect(mode(targetPath)).toBe(0o644);
    },
  );

  it("a rewrite (mod update) still produces the exact same guaranteed mode", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-rewrite-"));
    const targetDir = path.join(root, "media", "lua", "server");
    const targetPath = path.join(targetDir, "PanelBridge.lua");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, "-- v1\n");
    if (!isWindows) fs.chmodSync(targetPath, 0o600);

    writeLuaAtomic(targetPath, "-- v2, the actual update content\n");

    expect(fs.readFileSync(targetPath, "utf8")).toBe("-- v2, the actual update content\n");
    if (!isWindows) expect(mode(targetPath)).toBe(0o644);
  });
});

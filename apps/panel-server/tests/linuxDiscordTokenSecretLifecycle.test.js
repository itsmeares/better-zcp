import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isWindows = process.platform === "win32";

let tmpDir;
let originalUmask;

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

describe.skipIf(isWindows)(
  "discordBotToken.secret lifecycle on real Linux -- set / read / rotate / remove, mode checked at every step",
  () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discord-token-lifecycle-"));
      vi.resetModules();
      vi.doMock("../utils/paths.js", () => ({
        getDataPaths: () => ({ dataDir: tmpDir }),
      }));
    });

    afterEach(() => {
      if (originalUmask !== undefined) {
        process.umask(originalUmask);
        originalUmask = undefined;
      }
      vi.doUnmock("../utils/paths.js");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const secretPath = () => path.join(tmpDir, "discordBotToken.secret");

    it.each([0o022, 0o002, 0o077, 0o000])(
      "SET under umask %o: a fresh token file is 0600, not whatever the umask would otherwise leave a plain write at",
      async (umask) => {
        const { writeUiSecretFile, readUiSecretFile } = await import(
          "../utils/uiSecretFile.ts"
        );
        originalUmask = process.umask(umask);

        const control = path.join(tmpDir, "control-plain-write");
        fs.writeFileSync(control, "control");
        const controlMode = mode(control);

        writeUiSecretFile("discordBotToken", "first-real-token-value");

        expect(readUiSecretFile("discordBotToken")).toBe("first-real-token-value");
        expect(mode(secretPath())).toBe(0o600);
        if (umask === 0o000) {
          expect(controlMode).toBe(0o666);
          expect(mode(secretPath())).not.toBe(controlMode);
        }
      },
    );

    it("ROTATE: overwriting an already-set token file re-tightens the mode even if it drifted loose in between, under a hostile umask", async () => {
      const { writeUiSecretFile, readUiSecretFile } = await import(
        "../utils/uiSecretFile.ts"
      );
      originalUmask = process.umask(0o022);
      writeUiSecretFile("discordBotToken", "old-token-before-rotation");
      expect(mode(secretPath())).toBe(0o600);

      fs.chmodSync(secretPath(), 0o644);
      expect(mode(secretPath())).toBe(0o644);

      process.umask(0o000);
      writeUiSecretFile("discordBotToken", "new-token-after-rotation");

      expect(readUiSecretFile("discordBotToken")).toBe("new-token-after-rotation");
      expect(mode(secretPath())).toBe(0o600);
    });

    it("REMOVE then RE-SET: deleting via an empty value leaves no residual file, and a later re-set is unaffected by the deletion", async () => {
      const { writeUiSecretFile, readUiSecretFile } = await import(
        "../utils/uiSecretFile.ts"
      );
      originalUmask = process.umask(0o000);

      writeUiSecretFile("discordBotToken", "will-be-removed");
      expect(fs.existsSync(secretPath())).toBe(true);
      expect(mode(secretPath())).toBe(0o600);

      writeUiSecretFile("discordBotToken", "");
      expect(fs.existsSync(secretPath())).toBe(false);
      expect(readUiSecretFile("discordBotToken")).toBeNull();

      writeUiSecretFile("discordBotToken", "re-set-after-removal");
      expect(readUiSecretFile("discordBotToken")).toBe("re-set-after-removal");
      expect(mode(secretPath())).toBe(0o600);
    });

    it("full lifecycle in one pass -- set, read, rotate, remove -- content is correct and mode is 0600 at every live step", async () => {
      const { writeUiSecretFile, readUiSecretFile } = await import(
        "../utils/uiSecretFile.ts"
      );
      originalUmask = process.umask(0o000);

      writeUiSecretFile("discordBotToken", "token-v1");
      expect(readUiSecretFile("discordBotToken")).toBe("token-v1");
      expect(mode(secretPath())).toBe(0o600);

      writeUiSecretFile("discordBotToken", "token-v2-rotated");
      expect(readUiSecretFile("discordBotToken")).toBe("token-v2-rotated");
      expect(mode(secretPath())).toBe(0o600);

      writeUiSecretFile("discordBotToken", null);
      expect(fs.existsSync(secretPath())).toBe(false);
      expect(readUiSecretFile("discordBotToken")).toBeNull();
    });
  },
);

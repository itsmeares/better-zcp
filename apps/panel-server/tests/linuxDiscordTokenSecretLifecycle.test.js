import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// hunt-wave5-2026-08-29 suspect 3: discordBotToken moved out of db.json into
// its own file (utils/uiSecretFile.js). god's ask, verbatim: verify the
// WHOLE lifecycle end to end on real Linux -- set, read, rotate, remove --
// and check the FILE MODE, because Pam found a regenerated TLS key coming
// out 0644 (server.key survived from an earlier, looser install state; the
// regeneration branch only set `mode` on writeFileSync, which Node only
// honours when CREATING a file, so the stale mode was inherited instead of
// tightened). A mode that's correct on first creation is not evidence the
// mode is correct after a rotation that reuses the same path.
//
// Existing apps/panel-server/tests/uiSecretFile.test.js already covers the functional
// set/read/remove/migration behavior -- it has zero mode assertions. This
// file is specifically the missing mode half, run against real ext4 with a
// real varied process umask, the same matrix-plus-control technique as
// linuxSecretsFileModes.test.js.
//
// Mode assertions are meaningless on Windows (chmod only toggles the
// read-only attribute there) -- skipIf(win32), matching this codebase's
// established convention.
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
          "../utils/uiSecretFile.js"
        );
        originalUmask = process.umask(umask);

        // Positive control: a plain writeFileSync with no explicit mode, in
        // the SAME process, under the SAME umask, right next to the real
        // target -- proves the umask is actually doing something in this
        // environment before trusting the real target's result.
        const control = path.join(tmpDir, "control-plain-write");
        fs.writeFileSync(control, "control");
        const controlMode = mode(control);

        writeUiSecretFile("discordBotToken", "first-real-token-value");

        expect(readUiSecretFile("discordBotToken")).toBe("first-real-token-value");
        expect(mode(secretPath())).toBe(0o600);
        // Under a permissive umask (022/002) a plain write and an explicit
        // 0600 write can coincidentally land on different-but-still-safe
        // modes; the discriminating umask is 0000, where a plain write
        // comes out 0666 and would prove the control is actually exposed
        // while the real secret file stays 0600 regardless.
        if (umask === 0o000) {
          expect(controlMode).toBe(0o666);
          expect(mode(secretPath())).not.toBe(controlMode);
        }
      },
    );

    it("ROTATE: overwriting an already-set token file re-tightens the mode even if it drifted loose in between, under a hostile umask", async () => {
      const { writeUiSecretFile, readUiSecretFile } = await import(
        "../utils/uiSecretFile.js"
      );
      // Initial set under a normal umask.
      originalUmask = process.umask(0o022);
      writeUiSecretFile("discordBotToken", "old-token-before-rotation");
      expect(mode(secretPath())).toBe(0o600);

      // Simulate the exact shape of Pam's TLS finding: the file on disk
      // survives from an earlier, looser install state (an operator or an
      // older panel version could have left it at a laxer mode) before the
      // rotation write happens.
      fs.chmodSync(secretPath(), 0o644);
      expect(mode(secretPath())).toBe(0o644);

      // Rotate under the most hostile umask (0000, no bits masked away) --
      // if writeUiSecretFile relied on writeFileSync's `mode` option alone
      // (only honoured on file CREATION, not on a rewrite of an existing
      // path) this would stay at 0644, reproducing Pam's exact bug shape
      // for this file instead of certs.js's.
      process.umask(0o000);
      writeUiSecretFile("discordBotToken", "new-token-after-rotation");

      expect(readUiSecretFile("discordBotToken")).toBe("new-token-after-rotation");
      expect(mode(secretPath())).toBe(0o600);
    });

    it("REMOVE then RE-SET: deleting via an empty value leaves no residual file, and a later re-set is unaffected by the deletion", async () => {
      const { writeUiSecretFile, readUiSecretFile } = await import(
        "../utils/uiSecretFile.js"
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
        "../utils/uiSecretFile.js"
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

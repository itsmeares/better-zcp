import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";


const originalGetuid = process.getuid?.bind(process);
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* already removed or never chmod'd */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalGetuid) {
    Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
  }
});

function mkTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zcp-rootfirstrun-${label}-`));
  tempDirs.push(dir);
  return dir;
}

describe("formatOwnershipDiagnostic(): pure message formatting (no fs, no mocking)", () => {
  it("names every offending path, both accounts, and a single chown -R fix command", async () => {
    const { formatOwnershipDiagnostic } = await import("../utils/firstRunOwnershipCheck.ts");

    const message = formatOwnershipDiagnostic({
      paths: ["/opt/panel/data", "/opt/panel/logs"],
      runningAs: "pzuser (uid 1001)",
      owningAccounts: "root (uid 0)",
      fixCommand: 'chown -R pzuser:pzuser "/opt/panel/data" "/opt/panel/logs"',
    });

    expect(message).toContain("/opt/panel/data");
    expect(message).toContain("/opt/panel/logs");
    expect(message).toContain("pzuser (uid 1001)");
    expect(message).toContain("root (uid 0)");
    expect(message).toContain('chown -R pzuser:pzuser "/opt/panel/data" "/opt/panel/logs"');
    expect(message).toMatch(/do not run the panel as root\/sudo again/i);
    expect(message).toMatch(/does not loosen any file's permissions/i);
  });
});

describe("checkAndExitIfOwnershipBlocked(): real filesystem, zero permission mocking", () => {
  it.skipIf(process.platform === "win32")(
    "positive control: a directory this process genuinely owns and can access produces NO diagnosis",
    async () => {
      const { checkAndExitIfOwnershipBlocked } = await import(
        "../utils/firstRunOwnershipCheck.ts"
      );
      const dir = mkTempDir("owned");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("should not have exited");
      });

      const blocked = checkAndExitIfOwnershipBlocked([dir]);

      expect(blocked).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "POSITIVE CONTROL, REGULAR FILE: a normally-owned 0600 file (jwt.secret/db.json's own mode) owned by the running user MUST NOT be reported as offending -- catches the X_OK-on-a-regular-file bug (regression, 2026-08-29): X_OK checks the execute bit, which a 0600 file correctly never has, so R_OK|W_OK|X_OK against ANY correctly-owned secret/database file threw 100% of the time, even for root against a root-owned file. This assertion failed against the pre-fix code -- that's what makes it worth having.",
    async () => {
      const { checkAndExitIfOwnershipBlocked } = await import(
        "../utils/firstRunOwnershipCheck.ts"
      );
      const dir = mkTempDir("file-owned");
      const filePath = path.join(dir, "db.json");
      fs.writeFileSync(filePath, "{}", { mode: 0o600 });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("should not have exited");
      });

      const blocked = checkAndExitIfOwnershipBlocked([dir, filePath]);

      expect(blocked).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "REAL (unmocked) access denial on a REGULAR FILE: a 0600 file whose owner-read bit this process just cleared is detected -- proves R_OK|W_OK (not R_OK|W_OK|X_OK) is still a real, working check for files, not a mask that never fires",
    async () => {
      const { checkAndExitIfOwnershipBlocked } = await import(
        "../utils/firstRunOwnershipCheck.ts"
      );
      const dir = mkTempDir("file-locked");
      const filePath = path.join(dir, "jwt.secret");
      fs.writeFileSync(filePath, "secret", { mode: 0o600 });
      fs.chmodSync(filePath, 0o000);
      expect(() => fs.readFileSync(filePath)).toThrow(/EACCES/);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit(${code})`);
      });

      expect(() => checkAndExitIfOwnershipBlocked([filePath])).toThrow("exit(77)");

      expect(exitSpy).toHaveBeenCalledWith(77);
      const printed = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(printed).toContain(filePath);
    },
  );

  it("a path that doesn't exist yet is skipped, not treated as blocked (normal fresh-install case)", async () => {
    const { checkAndExitIfOwnershipBlocked } = await import("../utils/firstRunOwnershipCheck.ts");
    const dir = mkTempDir("parent");
    const neverCreated = path.join(dir, "does-not-exist");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("should not have exited");
    });

    const blocked = checkAndExitIfOwnershipBlocked([neverCreated]);

    expect(blocked).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("is a no-op on platforms without process.getuid (Windows) -- never exits, never throws", async () => {
    const { checkAndExitIfOwnershipBlocked } = await import("../utils/firstRunOwnershipCheck.ts");
    const dir = mkTempDir("winlike");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("should not have exited");
    });

    const blocked = checkAndExitIfOwnershipBlocked([dir]);

    expect(blocked).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "REAL (unmocked) access denial: a directory whose owner-bits this process just cleared is detected, diagnosed by name, and exits(77) -- exercises the exact detection path the root-first-run trap hits, under a genuine kernel-level EACCES",
    async () => {
      const { checkAndExitIfOwnershipBlocked } = await import(
        "../utils/firstRunOwnershipCheck.ts"
      );
      const dir = mkTempDir("locked");
      fs.chmodSync(dir, 0o000);
      expect(() => fs.readdirSync(dir)).toThrow(/EACCES/);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit(${code})`);
      });

      expect(() => checkAndExitIfOwnershipBlocked([dir])).toThrow("exit(77)");

      expect(exitSpy).toHaveBeenCalledWith(77);
      const printed = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(printed).toContain(dir);
      expect(printed).toMatch(/chown -R/);
    },
  );
});

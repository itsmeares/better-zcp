import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

// Root-first-run trap (2026-08-29, hunt-wave5 follow-up to card 9fe76d/
// c31675 -- operator report: "do we have to make it work on older install,
// like if someone install, will it fail because it is missing permission").
//
// WHAT PAM ESTABLISHED (treated as fact per god's card, re-derived here):
// an operator who runs the panel once with sudo just to look at it creates
// dataDir 0700 root:root -- jwt.secret, db.json, the startup backup, and
// the log files all land root-owned too, in that one run. The dedicated
// service account's next start then hits EACCES.
//
// WHAT I ADDED TO THAT (verified live, 2026-08-29, real useradd + su on
// WSL -- NOT reproducible as an automated vitest assertion, see below):
// the actual FIRST failure today (before this card's fix) is not
// jwtSecret.js's own error message at all -- it's an UNGUARDED
// fs.mkdirSync at server/database/init.js's top-level module code
// (creating data/backups/ inside the now-untraversable dataDir), which
// throws a raw uncaught EACCES stack trace before the panel prints even
// its version banner. Reproduction (for the record -- this is what "real
// useradd + su" looked like for this card, run manually, not committed as
// a script):
//   useradd -m -s /bin/bash pzuser
//   (as root) node apps/panel-server/index.js                    # creates data/ 0700 root:root
//   su pzuser -c 'node apps/panel-server/index.js'                # raw EACCES stack trace, no banner
//   chown -R pzuser:pzuser data logs                   # the fix this card's diagnostic prints
//   su pzuser -c 'node apps/panel-server/index.js'                # POSITIVE CONTROL: starts cleanly
//
// WHY THAT CAN'T BE A COMMITTED, CI-run vitest test: proving "access is
// DENIED to an unprivileged account" requires a second, genuinely
// unprivileged uid -- running the assertion as root (the only account that
// can create one via useradd) would prove nothing, because root ignores
// every permission bit being tested. A test that mocks fs.stat/fs.access
// to fake that denial proves nothing either -- see the card. So this file
// tests the two things that genuinely ARE provable inside a single test
// process, without mocking any permission primitive:
//
//   1. formatOwnershipDiagnostic() -- pure string assembly, no fs at all.
//   2. checkAndExitIfOwnershipBlocked() against a REAL, self-inflicted
//      access denial: chmod a directory THIS process owns down to 0000.
//      That's not a mock -- the kernel really does deny owner access when
//      the owner bits are cleared, and fs.accessSync really does throw.
//      It doesn't simulate the two-different-accounts operator scenario
//      (owner and running-as resolve to the same account here), but it
//      exercises the exact same detection/exit code path the real trap
//      hits, under a real EACCES the OS actually produced.

const originalGetuid = process.getuid?.bind(process);
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700); // undo any 0000 lockout so cleanup can actually delete it
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
    const { formatOwnershipDiagnostic } = await import("../utils/firstRunOwnershipCheck.js");

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
    // Prevention half, per the card's requirement 4: say why, in one line.
    expect(message).toMatch(/do not run the panel as root\/sudo again/i);
    // Boundary, per the card's requirement: never claims to loosen modes.
    expect(message).toMatch(/does not loosen any file's permissions/i);
  });
});

describe("checkAndExitIfOwnershipBlocked(): real filesystem, zero permission mocking", () => {
  it.skipIf(process.platform === "win32")(
    "positive control: a directory this process genuinely owns and can access produces NO diagnosis",
    async () => {
      const { checkAndExitIfOwnershipBlocked } = await import(
        "../utils/firstRunOwnershipCheck.js"
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
    "POSITIVE CONTROL, REGULAR FILE: a normally-owned 0600 file (jwt.secret/db.json's own mode) owned by the running user MUST NOT be reported as offending -- catches the X_OK-on-a-regular-file bug (god, 2026-08-29): X_OK checks the execute bit, which a 0600 file correctly never has, so R_OK|W_OK|X_OK against ANY correctly-owned secret/database file threw 100% of the time, even for root against a root-owned file. This assertion failed against the pre-fix code -- that's what makes it worth having.",
    async () => {
      const { checkAndExitIfOwnershipBlocked } = await import(
        "../utils/firstRunOwnershipCheck.js"
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
        "../utils/firstRunOwnershipCheck.js"
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
    const { checkAndExitIfOwnershipBlocked } = await import("../utils/firstRunOwnershipCheck.js");
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
    const { checkAndExitIfOwnershipBlocked } = await import("../utils/firstRunOwnershipCheck.js");
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
        "../utils/firstRunOwnershipCheck.js"
      );
      const dir = mkTempDir("locked");
      fs.chmodSync(dir, 0o000);
      // Sanity: prove the lockout is real before trusting the function under test.
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

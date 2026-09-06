// This file exists because 25 tests already covered buildLifecycleTemplate()
// and every one of them stopped at the generated STRING. None ever handed
// that string to real systemd, which is exactly how the original PR shipped
// with a WorkingDirectory= line that failed to load on every single Linux
// host, with a plain path, no special characters required. `execFile` is
// stubbed everywhere else in this suite -- this file is the one place that
// is not allowed to stub it: it shells out to the real `systemd-analyze`
// binary and treats its verdict as ground truth, the same way the bug was
// actually found.
//
// If systemd-analyze is not on this host, the suite SKIPS instead of
// silently reporting green -- see the loud console.warn below and the
// runtime-composed describe title, which names the skip in the test list
// itself rather than relying on a reader to notice a quieter skipped count.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildLifecycleTemplate } from "../services/linuxServiceLifecycle.js";

function hasSystemdAnalyze() {
  try {
    execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_SYSTEMD = hasSystemdAnalyze();
if (!HAS_SYSTEMD) {
  console.warn(
    "\n" +
      "!".repeat(78) +
      "\nSKIPPING linuxServiceLifecycleRealSystemd.test.js: `systemd-analyze` is " +
      "not on this host.\nThe generated systemd unit was NEVER checked against a " +
      "real init system on this run.\nThis is a degraded run, not a clean pass -- " +
      "do not treat a green suite here as proof the\nunit actually loads. Run on a " +
      "real systemd host (or this floor's WSL box) before trusting it.\n" +
      "!".repeat(78) +
      "\n",
  );
}

const server = {
  id: "alpha-1",
  serverName: "servertest",
};

// The four shapes already used to find and characterize the bug: a
// completely plain path (proved the bug was NOT limited to special
// characters -- every server failed), a space (the one case the pre-fix
// test suite claimed to cover, but never actually verified against real
// systemd), a literal "$" (systemd does not expand it anywhere in this
// unit, confirmed live -- it must round-trip completely unescaped), and an
// embedded double quote (the character the original bug's own escaping
// coincidentally handled *worse*, since it was being applied to a directive
// that does not use quoting grammar at all).
const CASES = [
  { label: "plain path, no special characters", installPath: "/opt/pzserver/server.sh" },
  { label: "path containing a space", installPath: "/opt/pz server/server.sh" },
  { label: "path containing a literal $", installPath: "/opt/pri$ce/server.sh" },
  { label: "path containing an embedded double quote", installPath: '/opt/od"d/server.sh' },
];

const describeRealSystemd = HAS_SYSTEMD ? describe : describe.skip;

describeRealSystemd(
  "linuxServiceLifecycle systemd unit -- verified against REAL systemd-analyze (SKIPPED: systemd-analyze not found on this host)",
  () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-systemd-verify-"));
    });

    afterEach(() => {
      for (const file of fs.readdirSync(tmpDir)) {
        fs.rmSync(path.join(tmpDir, file), { force: true });
      }
    });

    for (const { label, installPath } of CASES) {
      it(`generates a unit that real systemd accepts -- ${label}`, () => {
        const template = buildLifecycleTemplate(
          { ...server, installPath },
          "systemd",
          { serviceUser: "pzuser", homeDirectory: "/home/pzuser", fileExists: () => false },
        );

        const unitPath = path.join(tmpDir, `${server.id}-${label.replace(/[^a-z0-9]+/gi, "-")}.service`);
        fs.writeFileSync(unitPath, template.content);

        // systemd-analyze verify works on an arbitrary file path -- no
        // `--user`, no installation into ~/.config/systemd/user/, no running
        // session required. Safe to run concurrently with anything else on
        // a shared host: it never touches real systemd state.
        let result;
        try {
          result = execFileSync("systemd-analyze", ["verify", unitPath], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          throw new Error(
            `systemd-analyze verify rejected the generated unit for "${label}":\n` +
              `${error.stdout || ""}${error.stderr || ""}`.trim(),
          );
        }

        // A unit can exit 0 while still printing a warning to stderr (this
        // is exactly how "Ignoring unknown escape sequences" was found for
        // the old "\$" escaping -- a warning, not a hard failure). Fail the
        // test on ANY output, not just a non-zero exit code.
        expect(result.trim()).toBe("");

        // Cheap, independent confirmation that the plain-assignment
        // directive is genuinely unquoted (the actual bug), not just that
        // systemd tolerated it for some other reason.
        expect(template.content).not.toMatch(/^WorkingDirectory="/m);
      });
    }

    it("still quotes ExecStart= (Exec*= keeps the C-style tokenizer, unlike WorkingDirectory=)", () => {
      const template = buildLifecycleTemplate(
        { ...server, installPath: "/opt/pz server/server.sh" },
        "systemd",
        { serviceUser: "pzuser", homeDirectory: "/home/pzuser", fileExists: () => false },
      );
      expect(template.content).toMatch(/^ExecStart=\/bin\/bash "/m);
    });

    it("does not corrupt a literal $ with a spurious backslash (the old bug's exact symptom)", () => {
      const template = buildLifecycleTemplate(
        { ...server, name: "Test $5 Server", installPath: "/opt/pzserver/server.sh" },
        "systemd",
        { serviceUser: "pzuser", homeDirectory: "/home/pzuser", fileExists: () => false },
      );
      expect(template.content).toContain("Test $5 Server");
      expect(template.content).not.toContain("Test \\$5 Server");
    });

    it("escapes a literal % in Description= so it cannot be read as a systemd specifier", () => {
      // Real systemd expands recognized specifiers (e.g. "%h" -> the unit's
      // home directory) in plain assignment directives too, not just
      // Exec*=/Environment=. Confirmed live: an unescaped "%h" in
      // Description= silently became "/root". A server named with "%h" in
      // it must not leak the host's home directory into a unit file.
      const unitPath = path.join(tmpDir, "percent-specifier.service");
      const template = buildLifecycleTemplate(
        { ...server, name: "Survival %h Test", installPath: "/opt/pzserver/server.sh" },
        "systemd",
        { serviceUser: "pzuser", homeDirectory: "/home/pzuser", fileExists: () => false },
      );
      fs.writeFileSync(unitPath, template.content);
      execFileSync("systemd-analyze", ["verify", unitPath], { stdio: "ignore" });

      expect(template.content).toContain("Survival %%h Test");
    });
  },
);

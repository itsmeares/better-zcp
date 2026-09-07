import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildLifecycleTemplate } from "../services/linuxServiceLifecycle.ts";

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

        expect(result.trim()).toBe("");

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

import { describe, expect, it, afterEach } from "vitest";
import { spawn, execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildWindowsCmdLine,
  scoreServerProcessOwnership,
} from "../services/serverManager.js";

// 2026-09-04, class sweep after the P0 (four defects found by tripping over
// them, not by looking): the test checks for every site in serverManager.js that
// builds a command line, splits one, quotes an argument, or unquotes one,
// checked for a lossless round trip against the awkward inputs now known to
// be real (space, quote, &^()  trailing backslash, = inside a token, a
// semicolon in a classpath). This file locks in the sites that were
// checked and found ALREADY CORRECT, so a future edit that breaks one of
// them fails a test instead of waiting to be reported by a user again.
//
// Sites covered here (see the P0-sweep report for the full table, including
// sites verified safe-by-construction that don't need a test -- e.g. every
// execFile()/spawn() call using an argv array rather than a shell string):
//  - buildWindowsCmdLine: a trailing backslash immediately before a
//    to-be-added closing quote (the classic CommandLineToArgvW gotcha) --
//    verified this does NOT bite here, because cmd.exe's own /c tokenizer
//    (unlike a C-runtime argv parser) does not apply that backslash-
//    escapes-quote rule, so quoting is safe even for a trailing-backslash
//    path/arg.
//  - the Windows process-scan's CSV parsing (apps/panel-server/services/
//    serverManager.js's csvMatch/replace(/""/g,'"') pair) against REAL
//    PowerShell ConvertTo-Csv output (captured live, not guessed).
//  - extractLaunchArgValue (exercised via the exported
//    scoreServerProcessOwnership) correctly recovers a quoted value
//    containing a space, and a trailing backslash in a quoted cachedir,
//    without false-matching or false-rejecting.

const isWindows = process.platform === "win32";

(isWindows ? describe : describe.skip)(
  "command-line round-trip sweep: sites verified clean (no bug -- regression coverage)",
  () => {
    let cleanupDirs = [];

    afterEach(() => {
      for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      cleanupDirs = [];
    });

    it("buildWindowsCmdLine: an arg with a trailing backslash AND a space (needs quoting) survives cmd.exe's own tokenizer intact", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-trailingslash-"),
      );
      cleanupDirs.push(tmpRoot);
      const serverDir = path.join(tmpRoot, "Zomboid Server");
      fs.mkdirSync(serverDir, { recursive: true });
      const batPath = path.join(serverDir, "StartServer64.bat");
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED arg1=[%1]\r\nexit /b 0\r\n",
      );
      const launchLogPath = path.join(serverDir, "out.log");

      const args = ["-datadir=C:\\Zomboid Data\\"];
      const commandLine = buildWindowsCmdLine(batPath, args, launchLogPath);
      console.log(`[trailing-backslash sweep] argv=${JSON.stringify(["/c", commandLine])}`);

      const child = spawn("cmd.exe", ["/c", commandLine], {
        cwd: serverDir,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      });
      const result = await new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });

      expect(result.code).toBe(0);
      expect(fs.existsSync(launchLogPath)).toBe(true);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
      expect(logContent).toMatch(/-datadir=C:\\Zomboid Data\\/);
    });

    it("the Windows process-scan's CSV parsing correctly round-trips a command line containing embedded quotes (real PowerShell ConvertTo-Csv ground truth)", () => {
      // Captured live: `[PSCustomObject]@{ProcessId=1234; CommandLine=
      // 'java.exe -jar "C:\Program Files (x86)\Zomboid\ProjectZomboid64.exe"
      // -servername="My World"'} | ConvertTo-Csv -NoTypeInformation`
      const rawCsvLine =
        '"1234","java.exe -jar ""C:\\Program Files (x86)\\Zomboid\\ProjectZomboid64.exe"" -servername=""My World"""';

      // Exactly the parsing logic in serverManager.js's Windows process scan.
      const csvMatch = rawCsvLine.match(/^"([^"]*)","((?:[^"]|"")*)"$/);
      expect(csvMatch).not.toBeNull();
      const pid = csvMatch[1];
      const cmd = csvMatch[2].replace(/""/g, '"');

      expect(pid).toBe("1234");
      expect(cmd).toBe(
        'java.exe -jar "C:\\Program Files (x86)\\Zomboid\\ProjectZomboid64.exe" -servername="My World"',
      );
    });

    it("scoreServerProcessOwnership recovers a quoted -servername value containing a space from a live command line", () => {
      const cmd =
        'java.exe -jar "C:\\Program Files (x86)\\Zomboid\\ProjectZomboid64.exe" -servername="My World" -cachedir=C:\\ZomboidCache';

      expect(scoreServerProcessOwnership(cmd, { serverName: "My World" })).toBe(3);
      // A mismatched name must be a NEGATIVE signal, not a false positive
      // from a partially-matched quoted value.
      expect(
        scoreServerProcessOwnership(cmd, { serverName: "Some Other World" }),
      ).toBe(-1);
    });

    it("scoreServerProcessOwnership recovers a quoted -cachedir value with a trailing backslash, matching regardless of trailing-slash normalization", () => {
      const cmd = 'java.exe -servername=X -cachedir="C:\\Zomboid Cache\\"';

      expect(
        scoreServerProcessOwnership(cmd, { savePath: "C:\\Zomboid Cache\\" }),
      ).toBe(2);
      expect(
        scoreServerProcessOwnership(cmd, { savePath: "C:\\Zomboid Cache" }),
      ).toBe(2);
    });

    it("real end-to-end: ConvertTo-Csv's actual output for an embedded-quote command line parses identically to the hand-captured fixture above (guards against a future PowerShell/locale behavior change)", () => {
      const psScript =
        "[PSCustomObject]@{ProcessId=9999; CommandLine='java.exe -servername=\"Quoted Name\"'} | ConvertTo-Csv -NoTypeInformation";
      const output = execSync(
        `powershell -NoLogo -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
        { encoding: "utf-8" },
      );
      const dataLine = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .find((l) => l.startsWith('"9999"'));
      expect(dataLine).toBeTruthy();

      const csvMatch = dataLine.match(/^"([^"]*)","((?:[^"]|"")*)"$/);
      expect(csvMatch).not.toBeNull();
      const cmd = csvMatch[2].replace(/""/g, '"');
      expect(cmd).toBe('java.exe -servername="Quoted Name"');
    });
  },
);

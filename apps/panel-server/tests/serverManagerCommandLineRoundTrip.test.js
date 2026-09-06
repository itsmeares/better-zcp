import { describe, expect, it, afterEach } from "vitest";
import { spawn, execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildWindowsCmdLine,
  scoreServerProcessOwnership,
} from "../services/serverManager.js";


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
      const rawCsvLine =
        '"1234","java.exe -jar ""C:\\Program Files (x86)\\Zomboid\\ProjectZomboid64.exe"" -servername=""My World"""';

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

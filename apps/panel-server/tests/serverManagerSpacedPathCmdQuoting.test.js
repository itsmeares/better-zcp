import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildWindowsCmdLine } from "../services/serverManager.ts";


const isWindows = process.platform === "win32";

function makeBatFixture(dirSuffix) {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `zcp-spacedpath-${dirSuffix}-`),
  );
  const serverDir = path.join(tmpRoot, "Zomboid Server (x86)");
  fs.mkdirSync(serverDir, { recursive: true });
  const batPath = path.join(serverDir, "StartServer64.bat");
  fs.writeFileSync(batPath, "@echo off\r\necho MARKER_STARTED\r\nexit /b 0\r\n");
  const launchLogPath = path.join(serverDir, "server-launch.log");
  return { tmpRoot, batPath, launchLogPath };
}

function runCmd(cmdArgs, cwd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", cmdArgs, {
      cwd,
      detached: true,
      stdio: "ignore",
      ...opts,
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => resolve({ error: error.message }));
  });
}

(isWindows ? describe : describe.skip)(
  "Windows cmd.exe /c quoting on an install path containing a space and parens",
  () => {
    let cleanupDirs = [];

    afterEach(() => {
      for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      cleanupDirs = [];
    });

    it("REPRODUCES v1.2.15's regression: the old loose-argv construction fails on a spaced path (before)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeBatFixture("before");
      cleanupDirs.push(tmpRoot);

      const oldStyleArgs = ["/c", batPath, ">", launchLogPath, "2>&1"];
      const result = await runCmd(oldStyleArgs, path.dirname(batPath));

      expect(result.code).toBe(1);
      expect(fs.existsSync(launchLogPath)).toBe(false);
    });

    it("FIXED: buildWindowsCmdLine + windowsVerbatimArguments succeeds on the same spaced+parens path (after)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeBatFixture("after");
      cleanupDirs.push(tmpRoot);

      const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
      console.log(
        `[spaced-path fix] argv=${JSON.stringify(["/c", commandLine])}`,
      );

      const result = await runCmd(["/c", commandLine], path.dirname(batPath), {
        windowsVerbatimArguments: true,
      });

      expect(result.code).toBe(0);
      expect(fs.existsSync(launchLogPath)).toBe(true);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
    });

    it("handles spaces in both the batch path and the log path", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-spacedpath-"),
      );
      cleanupDirs.push(tmpRoot);
      const serverDir = path.join(tmpRoot, "Zomboid Server", "Serwer");
      fs.mkdirSync(serverDir, { recursive: true });
      const batPath = path.join(serverDir, "StartServer_TestWorld.bat");
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED\r\nexit /b 0\r\n",
      );
      const logsDir = path.join(tmpRoot, "Zomboid Server", "Panel", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const launchLogPath = path.join(logsDir, "server-launch.log");

      const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);

      const result = await runCmd(["/c", commandLine], serverDir, {
        windowsVerbatimArguments: true,
      });

      expect(result.code).toBe(0);
      expect(fs.existsSync(launchLogPath)).toBe(true);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
    });

    it("the fixed construction ALSO succeeds on a path with no space at all (no regression on the common no-space case)", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-spacedpath-nospace-"),
      );
      cleanupDirs.push(tmpRoot);
      const serverDir = path.join(tmpRoot, "ZomboidServer");
      fs.mkdirSync(serverDir, { recursive: true });
      const batPath = path.join(serverDir, "StartServer64.bat");
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED\r\nexit /b 0\r\n",
      );
      const launchLogPath = path.join(serverDir, "server-launch.log");

      const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
      const result = await runCmd(["/c", commandLine], serverDir, {
        windowsVerbatimArguments: true,
      });

      expect(result.code).toBe(0);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
    });

    it("succeeds when the bat path is clean but the LOG path has a space (launchLogPath comes from the panel's own data dir, independent of the server's install path)", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-spacedpath-asymmetric-"),
      );
      cleanupDirs.push(tmpRoot);
      const serverDir = path.join(tmpRoot, "CleanServerDir");
      fs.mkdirSync(serverDir, { recursive: true });
      const batPath = path.join(serverDir, "StartServer64.bat");
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED\r\nexit /b 0\r\n",
      );
      const logsDir = path.join(tmpRoot, "Panel Data (logs)");
      fs.mkdirSync(logsDir, { recursive: true });
      const launchLogPath = path.join(logsDir, "server-launch.log");

      const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
      console.log(
        `[asymmetric spaced-log-path fix] argv=${JSON.stringify(["/c", commandLine])}`,
      );
      const result = await runCmd(["/c", commandLine], serverDir, {
        windowsVerbatimArguments: true,
      });

      expect(result.code).toBe(0);
      expect(fs.existsSync(launchLogPath)).toBe(true);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
    });

    it("also fixes the custom-start-command shape (extra args after the bat path)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeBatFixture("args");
      cleanupDirs.push(tmpRoot);
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED %1\r\nexit /b 0\r\n",
      );

      const commandLine = buildWindowsCmdLine(
        batPath,
        ["-servername", "TestServer"],
        launchLogPath,
      );
      const result = await runCmd(["/c", commandLine], path.dirname(batPath), {
        windowsVerbatimArguments: true,
      });

      expect(result.code).toBe(0);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED -servername/);
    });
  },
);

(isWindows ? describe : describe.skip)(
  "Windows cmd.exe /c quoting on paths containing cmd.exe special characters (no spaces)",
  () => {
    let cleanupDirs = [];

    afterEach(() => {
      for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      cleanupDirs = [];
    });

    function makeSpecialCharFixture(dirName) {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-specialchar-"),
      );
      const serverDir = path.join(tmpRoot, dirName);
      fs.mkdirSync(serverDir, { recursive: true });
      const batPath = path.join(serverDir, "echoargs.bat");
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED\r\nexit /b 0\r\n",
      );
      const launchLogPath = path.join(serverDir, "server-launch.log");
      return { tmpRoot, batPath, launchLogPath };
    }

    it.each([
      ["ampersand", "Rock&Roll"],
      ["parens", "PZ(x86)"],
      ["caret", "PZ^1"],
    ])(
      "REPRODUCES the pre-widening regression: a %s in a space-free path still fails to start (before)",
      async (_label, dirName) => {
        const { tmpRoot, batPath, launchLogPath } =
          makeSpecialCharFixture(dirName);
        cleanupDirs.push(tmpRoot);

        const commandLine = `"${batPath} > ${launchLogPath} 2>&1"`;
        const result = await runCmd(
          ["/c", commandLine],
          path.dirname(batPath),
          { windowsVerbatimArguments: true },
        );

        expect(result.code).toBe(1);
        const logContent = fs.existsSync(launchLogPath)
          ? fs.readFileSync(launchLogPath, "utf-8")
          : "";
        expect(logContent).not.toMatch(/MARKER_STARTED/);
      },
    );

    it.each([
      ["ampersand", "Rock&Roll"],
      ["parens", "PZ(x86)"],
      ["caret", "PZ^1"],
    ])(
      "FIXED: the widened character class succeeds on a %s in a space-free path, log is non-empty (after)",
      async (_label, dirName) => {
        const { tmpRoot, batPath, launchLogPath } =
          makeSpecialCharFixture(dirName);
        cleanupDirs.push(tmpRoot);

        const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
        console.log(
          `[special-char fix: ${dirName}] argv=${JSON.stringify(["/c", commandLine])}`,
        );

        const result = await runCmd(
          ["/c", commandLine],
          path.dirname(batPath),
          { windowsVerbatimArguments: true },
        );

        expect(result.code).toBe(0);
        expect(fs.existsSync(launchLogPath)).toBe(true);
        const logContent = fs.readFileSync(launchLogPath, "utf-8");
        expect(logContent).toMatch(/MARKER_STARTED/);
      },
    );

    it("does NOT split a custom-start-command JVM arg containing '=' into two batch parameters (e.g. -Dfoo=bar)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeSpecialCharFixture(
        "EqualsArgTest",
      );
      cleanupDirs.push(tmpRoot);
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho ARG1=[%1] ARG2=[%2]\r\nexit /b 0\r\n",
      );

      const commandLine = buildWindowsCmdLine(
        batPath,
        ["-Dfoo=bar"],
        launchLogPath,
      );
      await runCmd(["/c", commandLine], path.dirname(batPath), {
        windowsVerbatimArguments: true,
      });

      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/ARG1=\["?-Dfoo=bar"?\] ARG2=\[\]/);
    });

    it("does NOT split a custom-start-command classpath arg containing ';' into multiple batch parameters (e.g. -cp a;b;c)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeSpecialCharFixture(
        "SemicolonArgTest",
      );
      cleanupDirs.push(tmpRoot);
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho ARG1=[%1] ARG2=[%2] ARG3=[%3] ARG4=[%4]\r\nexit /b 0\r\n",
      );

      const commandLine = buildWindowsCmdLine(
        batPath,
        ["-cp", "a;b;c"],
        launchLogPath,
      );
      await runCmd(["/c", commandLine], path.dirname(batPath), {
        windowsVerbatimArguments: true,
      });

      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/ARG1=\[-cp\] ARG2=\["?a;b;c"?\] ARG3=\[\]/);
    });

    it("does not add unnecessary inner quoting for a plain path (no false positives) -- only the outer wrapper's 2 quote chars", () => {
      const commandLine = buildWindowsCmdLine("C:\\Clean\\path.bat", [], null);
      expect(commandLine).toBe('"C:\\Clean\\path.bat"');
      expect(commandLine.split('"').length - 1).toBe(2);
    });
  },
);

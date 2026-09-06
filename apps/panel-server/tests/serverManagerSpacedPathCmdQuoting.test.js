import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildWindowsCmdLine } from "../services/serverManager.js";

// 2026-09-04, P0 (Charon's Discord report, live user broken on v1.2.15):
// apps/panel-server/services/serverManager.js's Windows spawn branches build a
// `cmd.exe /c` command line to launch the server's .bat and redirect its
// output into server-launch.log. As shipped in 41d0c6e5/1130108a (in
// v1.2.15), that command line was built from loose argv tokens --
// `["/c", batPath, ">", launchLogPath, "2>&1"]` -- and Node's Windows argv
// joiner quotes each token that contains a space independently. Any install
// path with a space in it (the common case: "C:\Program Files (x86)\...",
// "...\Zomboid Server\...", any user's home directory with a space) puts 4
// quote characters on the /c line. cmd.exe's documented quote-preservation
// rule (`cmd /?`) requires EXACTLY two quote characters to preserve them;
// with 4 it falls back to stripping only the first character of the whole
// line and the last quote character anywhere in it, corrupting the
// boundary between the bat path and the redirection. Result: cmd.exe exits
// 1 immediately, java.exe never launches, server-launch.log is never
// written -- exactly Charon's "Server process exited immediately after
// starting (code=1, signal=none)" with an empty log.
//
// These tests spawn a REAL cmd.exe against a REAL .bat file on disk (no
// mocking of child_process) because the whole point is cmd.exe's actual,
// notoriously undocumented quote-parsing behavior -- a mocked spawn() is
// structurally incapable of catching this (it was already covered by
// serverManagerWindowsSpawnFixes.test.js's mocked spawn assertions, which
// is exactly why that file didn't catch this regression before it shipped).
// The fixture path below has BOTH a space and parentheses, per the same
// bar.

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

      // This is exactly what 41d0c6e5/1130108a shipped: loose argv tokens,
      // letting Node quote batPath and launchLogPath independently.
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

    it("FIELD CASE (Charon's support bundle, confirmed 2026-09-04): a space in the directory name, NO parens, and a space in BOTH the bat path and the log path -- 'D:\\Zomboid Server\\Serwer\\' -- god's brief predicted parens were needed; they were not", async () => {
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zcp-spacedpath-charon-"),
      );
      cleanupDirs.push(tmpRoot);
      // Mirrors the reported install shape exactly: "Zomboid Server" as the
      // spaced segment, no parens anywhere, one level deeper for the actual
      // server dir (matching "D:\Zomboid Server\Serwer\").
      const serverDir = path.join(tmpRoot, "Zomboid Server", "Serwer");
      fs.mkdirSync(serverDir, { recursive: true });
      const batPath = path.join(serverDir, "StartServer_CharonWorld.bat");
      fs.writeFileSync(
        batPath,
        "@echo off\r\necho MARKER_STARTED\r\nexit /b 0\r\n",
      );
      // Panel Logs Dir in the bundle was also under the spaced "Zomboid
      // Server" root ("D:\Zomboid Server\Panel\logs"), so the log path
      // carries the same space too -- exactly 4 quote characters on the
      // real /c line, as confirmed.
      const logsDir = path.join(tmpRoot, "Zomboid Server", "Panel", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const launchLogPath = path.join(logsDir, "server-launch.log");

      const commandLine = buildWindowsCmdLine(batPath, [], launchLogPath);
      console.log(`[Charon field case] argv=${JSON.stringify(["/c", commandLine])}`);

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
      // Overwrite with a bat that echoes its args, to prove args survive
      // the quoting too, not just the bat path itself.
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

// 2026-09-04, P0 follow-up (adversarial review, same conversation as the
// spaced-path fix above): windowsQuoteArgIfNeeded originally triggered on
// whitespace/quotes ONLY. With windowsVerbatimArguments:true, Node's own
// argv quoting is no longer a backstop -- that regex is now the entire
// defence against cmd.exe treating a character as special, and cmd's
// special set (`&<>()@^|`) is not whitespace. This is the SAME regression
// (41d0c6e5/1130108a: v1.2.14 spawned the bare filename with cwd set, so
// the install directory never touched the /c line at all; v1.2.15 puts the
// full path on the line, exposing it to every cmd.exe special character,
// not just spaces) -- a user with "D:\Games\Rock&Roll\Server" was just as
// broken as a user with a space, with the identical exit-1/empty-log
// signature, and was NOT fixed by the space-only widening.
//
// A fixture path with a SPACE cannot catch this (same trap as the mocked-
// spawn suite, third time on this file) -- these paths are deliberately
// space-free so `&`/`(`/`)`/`^` are the only thing under test.
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

        // The OLD (whitespace-only) quoting: neither path needs quoting by
        // that rule, so this is exactly what the un-widened fix produced.
        const commandLine = `"${batPath} > ${launchLogPath} 2>&1"`;
        const result = await runCmd(
          ["/c", commandLine],
          path.dirname(batPath),
          { windowsVerbatimArguments: true },
        );

        expect(result.code).toBe(1);
        // The failure SHAPE differs by character: `&`/`^` never even open
        // the log (cmd's own redirection parse fails first, log missing --
        // the same signature as the spaced-path bug); `(` fails at command
        // lookup instead ("'...\PZ' is not recognized"), which cmd redirects
        // successfully, so the log exists but never contains a real start.
        // The shared, char-independent invariant is: the bat script never
        // actually ran.
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
      // Batch parameter substitution (%1, %2, ...) treats `,`, `;`, and `=`
      // as delimiters equivalent to whitespace (documented behavior) -- an
      // unquoted "-Dfoo=bar" arrives as TWO parameters ("-Dfoo" then
      // "bar"), silently shredding common JVM argument shapes. Quoting it
      // (this widening) keeps it as one.
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

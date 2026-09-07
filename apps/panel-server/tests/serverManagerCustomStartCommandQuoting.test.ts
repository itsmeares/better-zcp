import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildWindowsCmdLine,
  parseCustomStartCommand,
} from "../services/serverManager.ts";


const isWindows = process.platform === "win32";

function makeFixture(dirSuffix) {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `zcp-customcmd-${dirSuffix}-`),
  );
  const batPath = path.join(tmpRoot, "StartServer64.bat");
  fs.writeFileSync(
    batPath,
    "@echo off\r\necho MARKER_STARTED arg1=[%1]\r\nexit /b 0\r\n",
  );
  const launchLogPath = path.join(tmpRoot, "server-launch.log");
  return { tmpRoot, batPath, launchLogPath };
}

function tokenizeStartCommandOld(startCommand) {
  const parts = startCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [
    startCommand,
  ];
  const cmd = parts[0].replace(/^"|"$/g, "");
  const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ""));
  return { cmd, args };
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
  "custom start command tokenizer -- quote stripping mid-token",
  () => {
    let cleanupDirs = [];

    afterEach(() => {
      for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      cleanupDirs = [];
    });

    it("REPRODUCES the tracked bug: the old first/last-only strip leaves an unbalanced quote, cmd exits 0 with NO log (before)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeFixture("before");
      cleanupDirs.push(tmpRoot);

      const startCommand = `${batPath} -servername="My World"`;
      const { args } = tokenizeStartCommandOld(startCommand);
      expect(args).toEqual(['-servername="My World']);

      const commandLine = buildWindowsCmdLine(batPath, args, launchLogPath);
      const result = await runCmd(
        ["/c", commandLine],
        path.dirname(batPath),
        { windowsVerbatimArguments: true },
      );

      expect(result.code).toBe(0);
      expect(fs.existsSync(launchLogPath)).toBe(false);
    });

    it("FIXED: stripping every quote character recovers the bare value and the server actually starts (after)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeFixture("after");
      cleanupDirs.push(tmpRoot);

      const startCommand = `${batPath} -servername="My World"`;
      const { args } = parseCustomStartCommand(startCommand);
      expect(args).toEqual(["-servername=My World"]);

      const commandLine = buildWindowsCmdLine(batPath, args, launchLogPath);
      console.log(
        `[custom-start-command fix] argv=${JSON.stringify(["/c", commandLine])}`,
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
      expect(logContent).toMatch(/-servername=My World/);
    });

    it("no regression: a plain unquoted arg tokenizes and runs the same as before", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeFixture("plain");
      cleanupDirs.push(tmpRoot);

      const startCommand = `${batPath} -servername=Clean`;
      const { args } = parseCustomStartCommand(startCommand);
      expect(args).toEqual(["-servername=Clean"]);

      const commandLine = buildWindowsCmdLine(batPath, args, launchLogPath);
      const result = await runCmd(
        ["/c", commandLine],
        path.dirname(batPath),
        { windowsVerbatimArguments: true },
      );

      expect(result.code).toBe(0);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
    });

    it("no regression: a fully-quoted cmd path (the common case) still resolves to the bare path", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeFixture("fullquote");
      cleanupDirs.push(tmpRoot);

      const startCommand = `"${batPath}" -foo bar`;
      const { cmd, args } = parseCustomStartCommand(startCommand);
      expect(cmd).toBe(batPath);
      expect(args).toEqual(["-foo", "bar"]);

      const commandLine = buildWindowsCmdLine(cmd, args, launchLogPath);
      const result = await runCmd(
        ["/c", commandLine],
        path.dirname(batPath),
        { windowsVerbatimArguments: true },
      );

      expect(result.code).toBe(0);
      const logContent = fs.readFileSync(launchLogPath, "utf-8");
      expect(logContent).toMatch(/MARKER_STARTED/);
    });

    const VALIDATE_START_COMMAND_BLOCKLIST = /[&|;<>`${}()!%\[\]\n\r]/;

    it.each([
      ["&", true],
      ["<", true],
      [">", true],
      ["(", true],
      [")", true],
      ["|", true],
      [";", true],
      ["^", false],
      [",", false],
    ])(
      "validateStartCommand's blocklist %s -> blocked=%s (determines whether this character can ever reach parseCustomStartCommand via a real custom start command)",
      (char, expectedBlocked) => {
        expect(VALIDATE_START_COMMAND_BLOCKLIST.test(char)).toBe(
          expectedBlocked,
        );
      },
    );

    it.each([
      ["caret", "^"],
      ["comma", ","],
    ])(
      "chains parseCustomStartCommand -> buildWindowsCmdLine -> real cmd.exe for a %s inside an arg -- the two widened-class characters validateStartCommand actually lets through",
      async (label, char) => {
        const { tmpRoot, batPath, launchLogPath } = makeFixture(
          `chain-${label}`,
        );
        cleanupDirs.push(tmpRoot);
        fs.writeFileSync(
          batPath,
          "@echo off\r\necho MARKER_STARTED arg1=[%1]\r\nexit /b 0\r\n",
        );

        const rawArg = `-somearg=a${char}b`;
        const startCommand = `${batPath} ${rawArg}`;

        const { args } = parseCustomStartCommand(startCommand);
        expect(args).toEqual([rawArg]);

        const commandLine = buildWindowsCmdLine(batPath, args, launchLogPath);
        console.log(
          `[chain ${label}] argv=${JSON.stringify(["/c", commandLine])}`,
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
        expect(logContent).toContain(rawArg);
      },
    );
  },
);

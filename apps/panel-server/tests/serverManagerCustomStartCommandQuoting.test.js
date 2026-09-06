import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildWindowsCmdLine,
  parseCustomStartCommand,
} from "../services/serverManager.js";

// 2026-09-04, carded during the P0 review (2026-09-04T18-24-34-745Z),
// pre-existing bug, NOT a regression of the P0 fix itself:
//
// serverManager.js's custom-start-command tokenizer
// (`/(?:[^\s"]+|"[^"]*")+/g`) deliberately glues an unquoted run and an
// adjacent quoted run into ONE token with no separator between them, so
// `-servername="My World"` stays a single argument rather than splitting on
// the internal space. That's correct. The bug was in how the token got
// de-quoted afterward: `.replace(/^"|"$/g, "")` only strips a quote at the
// very start or the very end of the token, which assumes every quote sits
// at a token boundary. For `-servername="My World"` the leading character
// is `-` (no leading strip), but the trailing character IS the closing
// quote (stripped) -- leaving the unbalanced `-servername="My World`, one
// stray unpaired quote. Handed to buildWindowsCmdLine/
// windowsQuoteArgIfNeeded, that stray quote makes the /c line's total quote
// count odd, which corrupts cmd's parse WORSE than the original P0: cmd
// exits 0 and server-launch.log is never created -- no error signal
// anywhere, silently misfiled as a recurrence of the P0 bug this fixed.
//
// Fix: strip EVERY quote character from a token, not just the outermost
// pair. Every quote the tokenizer regex matched is grouping syntax it
// introduced itself (`"[^"]*"` already captured the space-containing
// content between a pair as the group's payload), never literal data, so
// removing all of them recovers the intended bare value regardless of
// where in the token they land.
//
// These tests spawn REAL cmd.exe against a REAL .bat file (no mocking) --
// same reasoning as serverManagerSpacedPathCmdQuoting.test.js: this is
// cmd.exe's actual quote-parsing behavior, which a mocked spawn() cannot
// observe.

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

// Mirrors the OLD (buggy) tokenizer logic, to prove the "before" behavior --
// this one is deliberately a local re-implementation since the whole point
// is comparing it against the REAL (fixed) parseCustomStartCommand,
// imported above, not another copy of it.
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

    it("REPRODUCES the carded bug: the old first/last-only strip leaves an unbalanced quote, cmd exits 0 with NO log (before)", async () => {
      const { tmpRoot, batPath, launchLogPath } = makeFixture("before");
      cleanupDirs.push(tmpRoot);

      const startCommand = `${batPath} -servername="My World"`;
      const { args } = tokenizeStartCommandOld(startCommand);
      expect(args).toEqual(['-servername="My World']); // the unbalanced token itself, observed not reasoned about

      const commandLine = buildWindowsCmdLine(batPath, args, launchLogPath);
      const result = await runCmd(
        ["/c", commandLine],
        path.dirname(batPath),
        { windowsVerbatimArguments: true },
      );

      // The worse-than-P0 signature: exits CLEANLY (0), and the log is
      // simply never created -- no error surfaces anywhere.
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

    // 2026-09-04, widened-class chain-coverage follow-up (Angela's audit):
    // windowsQuoteArgIfNeeded's widened trigger set is
    // `/[\s"&<>()^|,;=]/` -- of those, `=` and space were already proven
    // all the way through parseCustomStartCommand -> buildWindowsCmdLine ->
    // real cmd.exe (the two tests above). The rest were only proven against
    // buildWindowsCmdLine directly (serverManagerSpacedPathCmdQuoting.test.js
    // / serverManagerCommandLineRoundTrip.test.js), not chained through the
    // tokenizer first.
    //
    // Checked before writing a single chained test: `validateStartCommand()`
    // (serverManager.js, private, called before a custom start command ever
    // reaches parseCustomStartCommand) blocks
    // `/[&|;<>`${}()!%\[\]\n\r]/` outright with "Invalid start command".
    // That regex, mirrored exactly below and verified against every
    // character in the widened quoting class, blocks SEVEN of the nine
    // remaining ones -- `& < > ( ) | ;` can never reach
    // parseCustomStartCommand via a real custom start command at all, so
    // chaining a test through the tokenizer for them would exercise a
    // provably unreachable path, not close a real gap. Only `^` and `,`
    // pass validateStartCommand and can actually arrive at the tokenizer.
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

        // The tokenizer itself only splits on whitespace/quote boundaries --
        // neither `^` nor `,` is either, so this must come through as ONE
        // token, unmangled, before quoting ever sees it.
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

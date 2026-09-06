import { describe, expect, it } from "vitest";
import { redactRconCommandSecrets } from "../utils/rconCommandRedaction.js";

// bug-hunt-2026-08-27: command_history persisted `adduser "user" "pass"`
// verbatim -- a real player whitelist password, readable by anyone holding
// rcon.execute via GET /history, and sitting in cleartext on disk. Fixed at
// write time (database/init.js's logCommand), not read time. See
// rconCommandRedaction.js's own header for the full command-catalog
// enumeration this redactor is scoped to.

describe("redactRconCommandSecrets", () => {
  it("redacts the password argument from a two-arg adduser command", () => {
    expect(redactRconCommandSecrets('adduser "Bob" "hunter2"')).toBe(
      'adduser "Bob" "[REDACTED]"',
    );
  });

  it("is case-insensitive on the command name (a raw /execute console entry isn't constrained to lowercase)", () => {
    expect(redactRconCommandSecrets('ADDUSER "Bob" "hunter2"')).toBe(
      'ADDUSER "Bob" "[REDACTED]"',
    );
    expect(redactRconCommandSecrets('AddUser "Bob" "hunter2"')).toBe(
      'AddUser "Bob" "[REDACTED]"',
    );
  });

  it("leaves a one-arg adduser (no password, the Build 42 default) completely unchanged", () => {
    const noPassword = 'adduser "Bob"';
    expect(redactRconCommandSecrets(noPassword)).toBe(noPassword);
  });

  it("leaves every other command untouched, including ones with unrelated string args", () => {
    const untouched = [
      'kick "Bob" "griefing"',
      'setaccesslevel "Bob" "admin"',
      'banuser "Bob" "reason"',
      'servermsg "adduser is not a real broadcast"', // contains the word but not the shape
      "players",
      'teleport "Bob" "Alice"',
    ];
    for (const command of untouched) {
      expect(redactRconCommandSecrets(command)).toBe(command);
    }
  });

  it("redacts every adduser occurrence when more than one appears in the same string", () => {
    const two = 'adduser "Bob" "hunter2"; adduser "Alice" "correcthorse"';
    expect(redactRconCommandSecrets(two)).toBe(
      'adduser "Bob" "[REDACTED]"; adduser "Alice" "[REDACTED]"',
    );
  });

  it("passes non-string input through unchanged (response can legitimately be undefined/null)", () => {
    expect(redactRconCommandSecrets(undefined)).toBeUndefined();
    expect(redactRconCommandSecrets(null)).toBeNull();
  });

  it("redacts inside a response string too, in case a verbose RCON reply echoes the command it answered", () => {
    const echoed = 'Command received: adduser "Bob" "hunter2" -> User added';
    expect(redactRconCommandSecrets(echoed)).toBe(
      'Command received: adduser "Bob" "[REDACTED]" -> User added',
    );
  });
});

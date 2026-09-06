import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { VALID_ACTIONS } from "../routes/panelBridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

// 2026-08-29 backlog card pin-literal-sendcommand-strings-against-valid-
// actions. VALID_ACTIONS gates externally-triggered actions arriving through
// POST /command, but nothing checked the OTHER direction: every internal
// call site that hardcodes an action string and calls bridge.sendCommand()
// or panelBridge.sendCommand() directly (every dedicated route --
// /heal, /kill, /catalog/debug-item-script, etc. -- plus a few service-layer
// call sites) bypasses that whitelist check entirely, since it's the
// panel's OWN code making the call, not user input. A typo or a renamed
// action on one of those ~90 literal call sites would silently never work
// (the Lua side has no matching handler) with nothing here to catch it
// before a human notices the feature just doesn't do anything.
//
// Concretely found by writing this: "debugItemScript" (POST /catalog/
// debug-item-script) was called via sendCommand() but had never been added
// to VALID_ACTIONS -- not a runtime bug (PanelBridge.lua does implement
// the handler, confirmed by reading it), but a real gap in the one list
// meant to enumerate every action this codebase can send. Fixed alongside
// this test (see panelBridgeValidActionsDriftGate.test.js's updated pin and
// BRIDGE_ACTION_CAPABILITY's new entry -- adding an action to VALID_ACTIONS
// makes it reachable through POST /command too, so a capability gate had to
// be added at the same time, not an afterthought).
//
// Dynamic, not a snapshot pin like panelBridgeValidActionsDriftGate.test.js
// deliberately is: that file exists to force a human to review every
// addition/removal for a security implication (which capability gates it).
// This file exists to catch a typo/drift in an ordinary internal call site,
// which needs no review to fix -- re-scanning the real source on every run
// is the right shape here, not another list to keep in sync by hand.
const SCAN_FILES = [
  "apps/panel-server/routes/panelBridge.js",
  "apps/panel-server/services/panelBridge.js",
  "apps/panel-server/services/scheduler.js",
  "apps/panel-server/services/modChecker.js",
];

// Matches `sendCommand("action", ...)` / `sendCommand('action', ...)` on
// `bridge.sendCommand(...)`, `panelBridge.sendCommand(...)`, or (inside
// services/panelBridge.js itself, the class that DEFINES sendCommand)
// `this.sendCommand(...)` receivers -- deliberately not a bare
// `sendCommand(...)` match, to avoid false hits on an unrelated same-named
// method on a different object somewhere in these files. Only catches a
// LITERAL first argument; a computed one (e.g. routes/players.js's
// `bridge.sendCommand(bridgeAction, ...)`) is out of reach for a static
// scan by construction and isn't claimed here.
// The receiver and `.sendCommand(` are allowed whitespace/a newline between
// them -- scheduler.js formats one call as a multi-line chain
// (`panelBridge\n  .sendCommand(...)`).
const CALL_PATTERN = /(?:bridge|panelBridge|this)\s*\.\s*sendCommand\(\s*["']([A-Za-z0-9_]+)["']/g;

// Blanks comment text (preserving every newline and overall byte length, so
// line numbers stay accurate) before scanning -- without this, a comment
// that happens to mention `bridge.sendCommand("...")` verbatim (several do,
// including this file's own source) would false-positive as a real call
// site. Not a full JS tokenizer -- doesn't account for // or /* appearing
// inside a string literal -- but every file in SCAN_FILES is checked
// against the real vitest run below, and none trips that edge case today.
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, (m) => " ".repeat(m.length));
}

function extractLiteralActions(relativePath) {
  const content = stripComments(fs.readFileSync(path.join(ROOT, relativePath), "utf-8"));
  const found = new Map(); // action -> first line number, for a useful failure message
  let match;
  let lastIndex = 0;
  let line = 1;
  CALL_PATTERN.lastIndex = 0;
  while ((match = CALL_PATTERN.exec(content))) {
    line += content.slice(lastIndex, match.index).split("\n").length - 1;
    lastIndex = match.index;
    if (!found.has(match[1])) found.set(match[1], line);
  }
  return found;
}

describe("every literal sendCommand() action string is a real VALID_ACTIONS member", () => {
  for (const file of SCAN_FILES) {
    it(`${file}`, () => {
      const found = extractLiteralActions(file);
      const unknown = [...found.entries()].filter(([action]) => !VALID_ACTIONS.has(action));
      expect(
        unknown,
        unknown
          .map(([action, line]) => `"${action}" (${file}:${line}) is not in VALID_ACTIONS`)
          .join("; "),
      ).toEqual([]);
    });
  }

  it("the scan itself is not vacuous -- each file has at least one literal sendCommand call to check", () => {
    for (const file of SCAN_FILES) {
      expect(extractLiteralActions(file).size, file).toBeGreaterThan(0);
    }
  });
});

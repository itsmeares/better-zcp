import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { VALID_ACTIONS } from "../routes/panelBridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

const SCAN_FILES = [
  "apps/panel-server/routes/panelBridge.js",
  "apps/panel-server/services/panelBridge.js",
  "apps/panel-server/services/scheduler.ts",
  "apps/panel-server/services/modChecker.js",
];

const CALL_PATTERN = /(?:bridge|panelBridge|this)\s*\.\s*sendCommand\(\s*["']([A-Za-z0-9_]+)["']/g;

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, (m) => " ".repeat(m.length));
}

function extractLiteralActions(relativePath) {
  const content = stripComments(fs.readFileSync(path.join(ROOT, relativePath), "utf-8"));
  const found = new Map();
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

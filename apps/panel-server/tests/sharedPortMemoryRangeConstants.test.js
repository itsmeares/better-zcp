import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  BIND_PORT_MIN,
  BIND_PORT_MAX,
  DESTINATION_PORT_MIN,
  DESTINATION_PORT_MAX,
  GAME_PORT_MAX,
  MEMORY_GB_MIN,
  MIN_MEMORY_GB_MAX,
  MAX_MEMORY_GB_MAX,
} from "../routes/server.js";

// Regression coverage for a claim that was wrong, not just a bug: a prior
// commit said config.js's port/memory checks agreed with server.js's "by
// construction" because both import the same requireIntInRange function.
// That's true of the FUNCTION, but the sixteen call sites (ten in
// server.js, six in config.js) each hand-typed their own copies of the
// range numbers -- no shared constant anywhere, so a range change in one
// file silently left the other stale with every test still green (each
// file was only ever testing its own literals). This file makes the
// "by construction" claim actually true: it fails if either file goes back
// to a hand-typed literal at a requireIntInRange call site, and it fails if
// the exported constants themselves ever drift from the values every
// existing behavioural test (serverNumericFieldValidation.test.js,
// appSettingsHttpsValidation.test.js) was written against.
// See 2026-08-23 validateInt-coerces / config.js numeric-field audit.
//
// GitHub #118 (2026-08-26): the single PORT_MIN/PORT_MAX pair this
// described was itself the bug -- it applied a bind-socket floor (1024) to
// SFTP, a destination-only field whose standard port (22) is below it, so
// the panel rejected its own shipped default out of the box. The pair
// split into BIND_PORT_MIN/MAX (this panel process binds it: its own port,
// the game port when it launches PZ locally, and this file's/config.js's
// legacy single-server RCON target) and DESTINATION_PORT_MIN/MAX (a port on
// someone else's socket the panel only connects out to: SFTP, always).
// Asserting both pairs here, deliberately, rather than loosening this test
// to fit whatever server.js currently does -- a test that can't fail no
// matter what the range becomes isn't coverage.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "routes", "server.js");
const CONFIG_JS = path.join(__dirname, "..", "routes", "config.js");

describe("BIND_PORT_MIN/MAX, DESTINATION_PORT_MIN/MAX, GAME_PORT_MAX, MEMORY_GB_MIN/MIN_MEMORY_GB_MAX/MAX_MEMORY_GB_MAX", () => {
  it("match the ranges every existing behavioural test was written against", () => {
    expect(BIND_PORT_MIN).toBe(1024);
    expect(BIND_PORT_MAX).toBe(65535);
    expect(GAME_PORT_MAX).toBe(65534);
    expect(MEMORY_GB_MIN).toBe(1);
    expect(MIN_MEMORY_GB_MAX).toBe(64);
    expect(MAX_MEMORY_GB_MAX).toBe(128);
  });

  it("destination ports keep the bind ceiling but drop the bind floor -- a destination is never restricted to unprivileged ports, because this panel never binds it", () => {
    expect(DESTINATION_PORT_MIN).toBe(1);
    expect(DESTINATION_PORT_MAX).toBe(65535);
    expect(DESTINATION_PORT_MIN).toBeLessThan(BIND_PORT_MIN);
  });
});

// requireIntInRange(<value>, <min>, <max>, <label>) -- captures the min/max
// argument text so it can be checked for a bare numeric literal.
const CALL_SITE_RE = /requireIntInRange\([^,]+,\s*([^,]+),\s*([^,]+),/g;
const NUMERIC_LITERAL_RE = /^-?\d+(\.\d+)?$/;

function findLiteralRangeCallSites(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const relFile = path.relative(path.join(__dirname, ".."), filePath).replace(/\\/g, "/");
  const offenders = [];
  let match;
  CALL_SITE_RE.lastIndex = 0;
  while ((match = CALL_SITE_RE.exec(source))) {
    const [, minArg, maxArg] = match;
    if (NUMERIC_LITERAL_RE.test(minArg.trim()) || NUMERIC_LITERAL_RE.test(maxArg.trim())) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${relFile}:${line} -> requireIntInRange(..., ${minArg.trim()}, ${maxArg.trim()}, ...)`);
    }
  }
  return offenders;
}

describe("requireIntInRange call sites use named constants, not hand-typed literals", () => {
  it("server.js has no bare numeric min/max at a requireIntInRange call site", () => {
    const offenders = findLiteralRangeCallSites(SERVER_JS);
    expect(
      offenders,
      offenders.length
        ? `Found requireIntInRange call site(s) with a hand-typed literal range instead of a named constant:\n${offenders.join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("config.js has no bare numeric min/max at a requireIntInRange call site", () => {
    const offenders = findLiteralRangeCallSites(CONFIG_JS);
    expect(
      offenders,
      offenders.length
        ? `Found requireIntInRange call site(s) with a hand-typed literal range instead of a named constant:\n${offenders.join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("sanity check: the scan actually finds call sites in both files (guards against the regex silently matching nothing)", () => {
    const source = fs.readFileSync(SERVER_JS, "utf8");
    expect((source.match(/requireIntInRange\(/g) || []).length).toBeGreaterThanOrEqual(10);
    const configSource = fs.readFileSync(CONFIG_JS, "utf8");
    expect((configSource.match(/requireIntInRange\(/g) || []).length).toBeGreaterThanOrEqual(6);
  });
});

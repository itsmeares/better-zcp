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

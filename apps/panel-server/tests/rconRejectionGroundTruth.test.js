import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_RCON_REJECTIONS } from "../services/rcon.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, "../__fixtures__/pzRconRejectionStrings.json");

const KNOWN_BROKEN_PATTERNS = new Map([
  [
    "can be executed only from the game",
    "Confirmed absent from the entire jar as of this extraction (2026-08-27, build 24909800). See this file's own comment block above.",
  ],
]);

function loadFixture() {
  if (!fs.existsSync(FIXTURE_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.classes || typeof parsed.classes !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

const fixture = loadFixture();
const allStrings = fixture ? Object.values(fixture.classes).flat() : [];

const EXPECTED_CLASS_COUNT = 72;

describe("KNOWN_RCON_REJECTIONS vs the real PZ server jar (drift gate)", () => {
  it("the fixture exists, is valid JSON, and has a non-empty classes map", () => {
    expect(
      fixture,
      `ground-truth fixture missing, unparseable, or malformed at ${FIXTURE_PATH} -- ` +
        `run: node scripts/jar-audit/extract-rcon-rejection-strings.mjs`,
    ).not.toBeNull();
    expect(Object.keys(fixture.classes).length, "fixture has zero classes -- this gate would check nothing").toBeGreaterThan(0);
  });

  it(`scanned exactly ${EXPECTED_CLASS_COUNT} classes (the known resolved denominator)`, () => {
    expect(
      Object.keys(fixture.classes).length,
      "the number of scanned classes changed -- investigate before updating this number " +
        "(a silent drop must fail here, not pass quietly)",
    ).toBe(EXPECTED_CLASS_COUNT);
  });

  it("KNOWN_RCON_REJECTIONS is non-empty (nothing to gate if this is empty)", () => {
    expect(KNOWN_RCON_REJECTIONS.length).toBeGreaterThan(0);
  });

  it("every NON-known-broken pattern in KNOWN_RCON_REJECTIONS matches at least one string in the jar", () => {
    let compared = 0;
    const matchesNothing = [];
    for (const { pattern } of KNOWN_RCON_REJECTIONS) {
      const isKnownBroken = [...KNOWN_BROKEN_PATTERNS.keys()].some((source) => pattern.source.includes(source));
      if (isKnownBroken) continue;
      compared++;
      const hit = allStrings.some((s) => pattern.test(s));
      if (!hit) matchesNothing.push(pattern.toString());
    }
    expect(compared, "no patterns were checked -- this assertion would otherwise pass vacuously").toBeGreaterThan(0);
    expect(
      matchesNothing,
      "a pattern in KNOWN_RCON_REJECTIONS matches nothing in the real jar -- it will never fire again, " +
        "silently reporting a rejected command as a success. Either the text was reworded (find the new " +
        "literal), the check moved to a shared mechanism (see KNOWN_BROKEN_PATTERNS for the researched " +
        "example), or the rejection no longer happens at all.",
    ).toEqual([]);
  });

  it("KNOWN_BROKEN_PATTERNS entries genuinely still match nothing (self-cleaning: fails when a fix lands)", () => {
    for (const [source] of KNOWN_BROKEN_PATTERNS) {
      const entry = KNOWN_RCON_REJECTIONS.find((r) => r.pattern.source.includes(source));
      expect(entry, `KNOWN_BROKEN_PATTERNS references a pattern no longer in KNOWN_RCON_REJECTIONS: "${source}"`).toBeTruthy();
      const stillMatchesNothing = !allStrings.some((s) => entry.pattern.test(s));
      expect(
        stillMatchesNothing,
        `"${source}" now matches something in the jar again -- remove it from KNOWN_BROKEN_PATTERNS and let ` +
          "the main assertion above cover it (it will fail there instead if the match is wrong).",
      ).toBe(true);
    }
  });
});

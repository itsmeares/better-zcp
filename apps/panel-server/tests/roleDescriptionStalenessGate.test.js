import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { analyzeNamespace, ALL_LANGS } from "../../../scripts/i18n-staleness-check.mjs";

// regression follow-up to 35e529c (localeCapabilityDescriptionStaleness
// .test.js): that gate catches a capability description translation that was
// NEVER touched or was RESET TO ENGLISH -- byte-identical to the source. It
// cannot catch "translated once faithfully, then English changed and the
// translation was never revisited", because a real translation is never
// byte-identical to English regardless of which English version it came
// from. That second shape is exactly what happened tonight, twice:
// bridge.diagnostics' description (narrowed by d490410, then reverted and
// rewritten by 06a3657 after the test proved the wider claim true) and the
// 8-description undersell fix (6fada8c) both changed English capability
// text with nothing enforcing that the five translations get re-read.
//
// scripts/i18n-staleness-check.mjs already solves the general version of
// this problem -- git-blame timestamps plus a co-change-window heuristic,
// verified against real historical true/false positives (see that file's
// own header) -- but is deliberately REPORT-ONLY, never a gate, for the
// WHOLE i18n corpus: broad, frequently-edited UI text on a tree several
// people translate concurrently would make a hard gate noisy enough that
// it gets disabled, which is worse than no gate. That reasoning does not
// extend to roles.json's capability descriptions specifically: a small
// (~28 keys), rarely-edited set whose entire purpose is disclosing what
// power an operator is handing out. The two incidents above are exactly
// the cost of a stale one here. Narrow, argued exception -- gate THIS
// namespace only, reusing the exact validated analysis the report tool
// uses (not a re-implementation, which would risk disagreeing with it),
// and leave every other namespace report-only exactly as designed.
//
// === WHY THE SHALLOW-CLONE CHECK BELOW IS NOT OPTIONAL ===
// Verified empirically before trusting this gate at all (the same
// discipline the report tool's own header describes for itself): cloned
// this repo with `git clone --depth 1`, matching actions/checkout@v4's
// default when no fetch-depth is set (this project's ci.yml did not set
// one until this same change added it -- see server job's checkout step).
// On that shallow clone, `git blame --porcelain` attributed EVERY line of
// both en/roles.json and de/roles.json to the single shallow-boundary
// commit -- git cannot see further back, so it cannot report which commit
// really last touched a line. That collapses every gapMs in
// analyzeNamespace() to exactly 0, which the analysis correctly treats as
// "not stale" (gapMs <= 0 is filtered out) -- so a shallow checkout does
// not error, it silently reports zero findings, indistinguishable from a
// genuinely clean result. Shipping this gate without the check below would
// have been the exact "0/0 misconfigured instrument" failure this floor
// spent the night hunting, just built fresh into a brand new gate.
function isShallowClone() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "..", "..", "..");
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return out !== "false"; // "true", or anything unexpected -- fail closed
  } catch {
    // Could not even ask git -- fail closed rather than silently trust a
    // result this environment cannot actually back.
    return true;
  }
}

describe("capability description translations must be revisited when the English source changes (roles.json only -- see file header for why this namespace is gated and the rest of the i18n corpus is not)", () => {
  it("sanity check: this checkout has full git history, not a shallow clone -- git blame needs it, and a shallow clone makes the staleness check below silently pass regardless of real drift", () => {
    expect(
      isShallowClone(),
      "This checkout is shallow. git blame on a shallow clone attributes every line to the shallow boundary commit, collapsing every real gap to 0 -- the staleness check in this file would silently report clean regardless of actual drift. Fetch full history (`git fetch --unshallow` locally; `fetch-depth: 0` on actions/checkout in CI, already set on the server job for this reason) before trusting it.",
    ).toBe(false);
  });

  it("no capability description translation is older than a real edit to its English source, outside the 30-minute co-change window", () => {
    const findings = analyzeNamespace("roles.json", ALL_LANGS);
    expect(
      findings,
      findings.length
        ? findings
            .map(
              (f) =>
                `${f.lang}/roles.json key "${f.key}": English's description changed ${f.gapMinutes}min after this translation was last touched (en=${f.enHash}, ${f.lang}=${f.langHash}). Read both languages' current text -- if the meaning changed, update the translation; if it didn't (wording-only), touching the translation file (even a no-op re-save) clears this the same way a real update would.`,
            )
            .join("\n\n")
        : "",
    ).toEqual([]);
  });
});

import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { analyzeNamespace, ALL_LANGS } from "../../../scripts/i18n-staleness-check.mjs";

function isShallowClone() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "..", "..", "..");
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return out !== "false";
  } catch {
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

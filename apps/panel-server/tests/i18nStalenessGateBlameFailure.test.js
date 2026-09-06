import { describe, expect, it, vi } from "vitest";

// staleness-gate-reported-3-of-5-stale-locales (2026-09-02): one run of the
// roles.json gate reported exactly 3 of 5 equally-stale locales (fr, de, es
// -- ht and zh-CN missing); a second run of the same test on the same
// commit reported all 5. Staged in an isolated scratch repo: with a
// synthetic git-blame failure injected for one language, on a tree where
// that language was the ONLY stale one, the report came back clean for it
// -- the exact same shape as a genuinely up-to-date translation. Root
// cause: scripts/i18n-staleness-check.mjs's git() helper collapses every
// git-invocation failure (transient lock contention, resource exhaustion,
// or a genuinely untranslated file) to the same `null`, and
// analyzeNamespace() silently `continue`d past a null result regardless of
// which case it was. Fixed by making keyMapForFile() distinguish the two:
// "file doesn't exist on disk" is still a legitimate silent skip (a
// namespace not yet localized into this language), but "file exists and
// git blame still failed" now throws, so a transient failure surfaces
// instead of masquerading as "nothing to report".
vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return {
    ...actual,
    execFileSync: (cmd, args, opts) => {
      const isBlameOfHt =
        cmd === "git" &&
        Array.isArray(args) &&
        args[0] === "blame" &&
        args.some((a) => typeof a === "string" && a.includes("apps/panel-client/src/locales/ht/roles.json"));
      if (isBlameOfHt) {
        throw new Error("simulated transient git failure (lock contention / resource exhaustion)");
      }
      return actual.execFileSync(cmd, args, opts);
    },
  };
});

const { analyzeNamespace, ALL_LANGS } = await import("../../../scripts/i18n-staleness-check.mjs");

describe("i18n-staleness-check: a transient git-blame failure for one language must not be silently reported as clean", () => {
  it("throws instead of silently dropping the language from findings", () => {
    expect(() => analyzeNamespace("roles.json", ALL_LANGS)).toThrow(
      /git blame failed for .*ht\/roles\.json/,
    );
  });

  it("is narrow -- a language whose blame call succeeds is unaffected", () => {
    expect(() => analyzeNamespace("roles.json", ["fr", "de", "es", "zh-CN"])).not.toThrow();
  });
});

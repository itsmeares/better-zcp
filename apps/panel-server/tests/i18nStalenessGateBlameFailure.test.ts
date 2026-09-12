import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";

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

  it("does not print git errors when a locale file was added with no parent file", () => {
    const script = fileURLToPath(
      new URL("../../../scripts/i18n-staleness-check.mjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [script, "--ns=console", "--lang=fr"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("fatal: path");
  });
});

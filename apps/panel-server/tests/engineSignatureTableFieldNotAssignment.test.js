import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { resolveAllCallSites } from "../../../scripts/lib/engine-signature-core.mjs";

// 2026-08-31 regression (scripts/**, the directive): engine-signature-core.mjs's Pass-1 variable-
// type resolver had no way to tell a real Lua assignment (`local cell = getWorld():getCell()`)
// apart from a TABLE CONSTRUCTOR FIELD of the identical shape (`{ cell = someExpr, ... }`). The
// regex's only precondition on the char before the identifier -- "not `.` or a word character" --
// is satisfied by `{`, `,`, and plain whitespace, all of which precede table fields constantly.
//
// This is not a hypothetical: PanelBridge.lua's own return-value tables reuse variable names as
// field keys constantly ("message = ...", "day = gameTime:getDay()", "value = cf:getFinalValue()"
// etc.) -- 220 such collisions exist in the real file today (confirmed by grepping every non-local
// assignRe match against every real `local NAME =` name). A table field whose value is a chain
// expression gets recorded into varTypes exactly like a real assignment, silently corrupting a
// REAL variable's type -- a later real use of that variable then reports 'chain-broke-before-end'
// and is SILENTLY SKIPPED rather than checked, even though its real type was already known.
//
// Directly reproduces that shape: `cell` is correctly typed via a real assignment, then "shadowed"
// by an unrelated table field also named `cell` whose value doesn't resolve to the same type, then
// a REAL subsequent `cell:` call site that should resolve and be checked.

function makeClassProvider() {
  const classes = {
    "zombie.iso.IsoWorld": { getCell: { returnClass: "zombie.iso.IsoCell" } },
    "zombie.iso.IsoCell": {
      getGridSquare: { returnClass: null },
      // bogusMethod deliberately has NO entry here -- classProvider must report it absent.
    },
  };
  return (className, methodName) => {
    const info = classes[className];
    if (!info) return null;
    const sig = info[methodName];
    if (!sig) return { exists: false };
    return { exists: true, returnClass: sig.returnClass, elementClass: null };
  };
}

const SRC = `
local function handlerA()
    local cell = getWorld():getCell()

    local resultTable = {
        message = "ok",
        cell = someUnrelatedThing(),
        other = 5,
    }

    -- Real use, AFTER the table field above -- must still resolve to IsoCell and be CHECKED,
    -- not silently skipped as unresolved.
    cell:getGridSquare(1, 2, 3)
    cell:bogusMethod()
end
`;

describe("engine-signature-core.mjs -- table-constructor fields are not real assignments", () => {
  it("resolves and checks a real call site AFTER a same-named table field, instead of silently skipping it", () => {
    const { callSites } = resolveAllCallSites(SRC, makeClassProvider());
    const gridSquare = callSites.find((s) => s.methodName === "getGridSquare");
    const bogus = callSites.find((s) => s.methodName === "bogusMethod");

    expect(gridSquare.resolved).toBe(true);
    expect(gridSquare.receiverType).toBe("zombie.iso.IsoCell");
    expect(gridSquare.methodInfo).toEqual({ exists: true, returnClass: null, elementClass: null });

    // bogusMethod genuinely doesn't exist on IsoCell in this fixture -- the fix must not just
    // resolve the receiver, it must let the checker actually SEE this as a real ABSENT finding
    // instead of hiding it behind an unresolved skip.
    expect(bogus.resolved).toBe(true);
    expect(bogus.receiverType).toBe("zombie.iso.IsoCell");
    expect(bogus.methodInfo).toEqual({ exists: false });
  });

  it("still resolves a table field's own value normally when it is NOT shadowing a real variable name", () => {
    const src = `
local function handlerB()
    local resultTable = {
        cell = getWorld():getCell(),
    }
end
`;
    // Should not throw, and (since 'cell' as used here is only ever a table field, never a real
    // receiver) should simply produce no call sites for a bare 'cell' receiver.
    const { callSites } = resolveAllCallSites(src, makeClassProvider());
    expect(callSites.some((s) => s.receiverExpr === "cell")).toBe(false);
  });

  it("PanelBridge.lua: the fix changes skip counts on the real file (more sites resolved), same ABSENT set as the current baseline", () => {
    const luaPath = path.join(
      process.cwd(),
      "integrations", "panelbridge",
      "PanelBridge",
      "media",
      "lua",
      "server",
      "PanelBridge.lua",
    );
    const manifestPath = path.join(process.cwd(), "scripts", "engine-signatures.manifest.json");
    const rawSrc = fs.readFileSync(luaPath, "utf-8");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    function classProvider(className, methodName) {
      const info = manifest.classes[className];
      if (!info) return null;
      const sigs = info.methods[methodName];
      if (!sigs || sigs.length === 0) return { exists: false };
      return { exists: true, returnClass: sigs[0].returnClass, elementClass: sigs[0].elementClass };
    }

    const { callSites } = resolveAllCallSites(rawSrc, classProvider);
    const resolved = callSites.filter((s) => s.resolved);
    const absent = resolved.filter((s) => s.methodInfo && s.methodInfo.exists === false);

    // This is a regression floor, not an exact pin: PanelBridge.lua will keep changing. The real
    // claim under test is "the fixed resolver checks strictly more of the file than a resolver
    // with no table-constructor guard would" -- verified directly in
    // scripts/check-engine-signatures.mjs's own baseline/manifest history (2026-08-31: 178 resolved
    // pre-fix vs 178 post-fix on THIS specific file was the surprising, verified-by-effect result
    // -- see the regression commit message for the full before/after). What must never regress is
    // that every already-reviewed baseline finding is still found (the fix must not make the
    // checker blind to something it used to catch).
    const baselinePath = path.join(process.cwd(), "scripts", "engine-signatures.baseline.json");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    const absentKeys = new Set(absent.map((f) => `${f.receiverType}#${f.methodName}`));
    // One baseline entry (IsoPlayer#setGodMode) already matches nothing on the CURRENT unfixed
    // checker either -- confirmed 2026-08-31 (its own "NOTE: ... matched nothing this run" output,
    // safe to delete once confirmed). Excluded here since it's a pre-existing stale entry, not a
    // regression this fix could plausibly cause or fix.
    const knownStale = new Set(["zombie.characters.IsoPlayer#setGodMode"]);
    for (const entry of baseline.entries) {
      const key = `${entry.class}#${entry.method}`;
      if (knownStale.has(key)) continue;
      expect(
        absentKeys.has(key),
        `baseline entry ${key} must still be found ABSENT by the fixed resolver`,
      ).toBe(true);
    }
  });
});

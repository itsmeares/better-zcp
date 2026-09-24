import { describe, it, expect } from "vite-plus/test";
import { resolveAllCallSites } from "../../../scripts/lib/engine-signature-core.mjs";


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
    const { callSites } = resolveAllCallSites(src, makeClassProvider());
    expect(callSites.some((s) => s.receiverExpr === "cell")).toBe(false);
  });


});

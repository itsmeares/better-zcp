import { describe, expect, it } from "vitest";
import { hasIniKeyLine, hasIniKeyValue, setIniKeyLine } from "../utils/iniKeyWrite.js";

// The test that matters (per the 2026-08-31 dispatch): an unanchored
// content.includes("Key=")/content.replace(/Key=.*/g, ...) pair rewrites ANY
// line containing that substring, not just the line whose KEY is Key --
// including a free-text field (ServerWelcomeMessage, PublicDescription) that
// happens to contain the literal text "RCONPassword=". A test asserting only
// "the RCONPassword line changed to the new value" passes on the buggy code
// too, since the buggy code DOES update that line -- it also corrupts the
// unrelated line, which is the part that has to be asserted.
describe("iniKeyWrite -- anchored key read/write, not substring matching", () => {
  const freeTextCollision = [
    "PVP=false",
    'ServerWelcomeMessage="Welcome! Note: RCONPassword=notapassword is a decoy some griefer left in chat."',
    "RCONPassword=old-secret",
    "RCONPort=27015",
  ].join("\n");

  describe("setIniKeyLine", () => {
    it("updates only the real assignment line, leaving a free-text field containing the same substring untouched", () => {
      const updated = setIniKeyLine(freeTextCollision, "RCONPassword", "new-secret");

      expect(updated).toContain("RCONPassword=new-secret");
      expect(updated).toContain(
        'ServerWelcomeMessage="Welcome! Note: RCONPassword=notapassword is a decoy some griefer left in chat."',
      );
      // No second/duplicate RCONPassword line was appended.
      expect(updated.match(/^RCONPassword=/gm)).toHaveLength(1);
      // Exactly 4 lines in, 4 lines out -- nothing got split or duplicated.
      expect(updated.split("\n")).toHaveLength(4);
    });

    it("appends a new line when the key has no existing assignment line", () => {
      const updated = setIniKeyLine("PVP=false\n", "RCONPort", 27016);
      expect(updated).toBe("PVP=false\n\nRCONPort=27016");
    });

    it("tolerates spaces around '=' the same way parseIni()/toIni() and findDuplicateIniKeys() do", () => {
      const updated = setIniKeyLine("RCONPassword = old\n", "RCONPassword", "new");
      expect(updated).toBe("RCONPassword=new\n");
    });

    it("replaces only the first assignment line when (unexpectedly) more than one exists, never touching a value-collision elsewhere", () => {
      const dup = "RCONPort=1\nRCONPort=2\n";
      const updated = setIniKeyLine(dup, "RCONPort", 3);
      expect(updated).toBe("RCONPort=3\nRCONPort=2\n");
    });
  });

  describe("hasIniKeyLine", () => {
    it("is true for a real assignment line", () => {
      expect(hasIniKeyLine(freeTextCollision, "RCONPassword")).toBe(true);
    });

    it("is false when the key only appears inside another field's free text", () => {
      expect(hasIniKeyLine("ServerWelcomeMessage=\"see RCONPassword=x\"\n", "RCONPassword")).toBe(
        false,
      );
    });
  });

  describe("hasIniKeyValue", () => {
    it("is true only when the key's own line has exactly that value", () => {
      expect(hasIniKeyValue(freeTextCollision, "RCONPassword", "old-secret")).toBe(true);
      expect(hasIniKeyValue(freeTextCollision, "RCONPassword", "new-secret")).toBe(false);
    });

    it("does not false-positive off a free-text field containing the same key=value substring", () => {
      const content =
        'ServerWelcomeMessage="use RCONPassword=hunter2 to log in"\nRCONPassword=other\n';
      expect(hasIniKeyValue(content, "RCONPassword", "hunter2")).toBe(false);
    });
  });
});

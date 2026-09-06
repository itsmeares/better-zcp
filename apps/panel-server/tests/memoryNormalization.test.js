import { describe, expect, it } from "vitest";
import { normalizeMemoryGb } from "../utils/memory.js";

describe("normalizeMemoryGb", () => {
  it.each(["4junk", "4.9", "1e2", "", 0, -1])(
    "uses the fallback for malformed memory values: %s",
    (value) => {
      expect(normalizeMemoryGb(value, 4)).toBe(4);
    },
  );

  it("keeps valid GB and legacy MB values", () => {
    expect(normalizeMemoryGb("8", 4)).toBe(8);
    expect(normalizeMemoryGb(4096, 4)).toBe(4);
  });
});
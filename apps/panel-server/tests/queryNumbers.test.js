import { describe, expect, it } from "vitest";
import {
  parseBoundedInteger,
  parseClampedInteger,
} from "../utils/queryNumbers.js";

describe("parseBoundedInteger", () => {
  it.each(["12junk", "1.5", "-1", "1e2", "", null, undefined])(
    "returns the fallback for malformed or out-of-range input: %s",
    (value) => {
      expect(parseBoundedInteger(value, 100, 1, 500)).toBe(100);
    },
  );

  it("clamps valid values to the configured maximum", () => {
    expect(parseBoundedInteger("999", 100, 1, 500)).toBe(100);
    expect(parseBoundedInteger(" 25 ", 100, 1, 500)).toBe(25);
  });

  it("clamps an oversized valid value without accepting a numeric prefix", () => {
    expect(parseClampedInteger("999", 100, 1, 500)).toBe(500);
    expect(parseClampedInteger("999junk", 100, 1, 500)).toBe(100);
  });
});

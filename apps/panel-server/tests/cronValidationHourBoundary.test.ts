import { describe, expect, it } from "vitest";
import { isCronTooFrequent } from "../utils/cronValidation.ts";

describe("isCronTooFrequent() -- hour-boundary wrap, not just the literal '*' hour case", () => {
  it("catches a sub-5-minute gap across two LISTED (non-wildcard) adjacent hours", () => {
    expect(isCronTooFrequent("0,58 5,6 * * *")).toBe(true);
  });

  it("catches the same shape spanning midnight (23:58 -> 0:00)", () => {
    expect(isCronTooFrequent("58,0 23,0 * * *")).toBe(true);
  });

  it("still accepts a single-hour schedule with well-spaced minutes", () => {
    expect(isCronTooFrequent("0,30 5 * * *")).toBe(false);
  });

  it("still accepts listed hours that are far enough apart to never wrap", () => {
    expect(isCronTooFrequent("0,58 5,12 * * *")).toBe(false);
  });

  it("still catches the original wildcard-hour wrap case (regression guard)", () => {
    expect(isCronTooFrequent("0,58 * * * *")).toBe(true);
  });
});

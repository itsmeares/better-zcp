import { describe, expect, it } from "vitest";
import { isCronTooFrequent } from "../utils/cronValidation.js";

// regression (apps/panel-server/utils sweep): isCronTooFrequent()'s
// wrap-around check used to fire only when the hour field was the literal
// string "*" -- so a discrete multi-value hour list that means the exact
// same "every listed hour" thing (e.g. "5,6") never triggered it, and a
// minute value near the top of one listed hour combined with a minute
// value near the bottom of the NEXT listed hour could fire well under the
// documented 5-minute floor without ever being flagged. No dedicated unit
// test existed for this function at all before this file -- only indirect
// coverage through scheduler route tests, none of which exercised a
// discrete (non-wildcard) multi-value hour field.
describe("isCronTooFrequent() -- hour-boundary wrap, not just the literal '*' hour case", () => {
  it("catches a sub-5-minute gap across two LISTED (non-wildcard) adjacent hours", () => {
    // Fires at 5:58 and 6:00 -- 2 minutes apart.
    expect(isCronTooFrequent("0,58 5,6 * * *")).toBe(true);
  });

  it("catches the same shape spanning midnight (23:58 -> 0:00)", () => {
    expect(isCronTooFrequent("58,0 23,0 * * *")).toBe(true);
  });

  it("still accepts a single-hour schedule with well-spaced minutes", () => {
    expect(isCronTooFrequent("0,30 5 * * *")).toBe(false);
  });

  it("still accepts listed hours that are far enough apart to never wrap", () => {
    // 5:58 and 12:00 are hours apart, not minutes.
    expect(isCronTooFrequent("0,58 5,12 * * *")).toBe(false);
  });

  it("still catches the original wildcard-hour wrap case (regression guard)", () => {
    expect(isCronTooFrequent("0,58 * * * *")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ACCESS_LEVELS } from "../utils/commands.ts";

const EXPECTED_ACCESS_LEVELS = ["admin", "moderator", "gm", "observer", "priority", "user", "none"];

describe("ACCESS_LEVELS: pin (regression drift gate)", () => {
  it("apps/panel-server/utils/commands.js's ACCESS_LEVELS matches the pinned, jar-derived list exactly", () => {
    expect(ACCESS_LEVELS).toEqual(EXPECTED_ACCESS_LEVELS);
  });

  it("does not contain 'overseer' (confirmed absent from the default Roles table)", () => {
    expect(ACCESS_LEVELS).not.toContain("overseer");
  });

  it("contains 'priority' (a real setupRole() id previously missing from this array)", () => {
    expect(ACCESS_LEVELS).toContain("priority");
  });
});

import { describe, expect, it } from "vitest";
import { ACCESS_LEVELS } from "../utils/commands.js";

// regression-2026-08-30: ACCESS_LEVELS used to be curated from "the
// official PZ Admin Commands wiki (Build 42.17.0)" -- a citation with its
// own expiry date, and it was wrong in both directions. 'overseer' is a
// declared getDefaultForOverseer() method in the real server jar's
// zombie/characters/Roles.class with NO backing setupRole() id literal
// anywhere in the class (same fingerprint as the already-known-dead
// getDefaultForNewUser()) -- apps/panel-server/routes/players.js:311 let it through
// its own validation, so the panel offered a dropdown choice that could
// only ever fail. 'priority' is the opposite defect: a real setupRole() id
// (getDefaultForPriorityUser(), in-game display "PriorityUser") that was
// missing from the array entirely, making it impossible to set from this
// panel at all even though the server genuinely accepts it. Full evidence
// in apps/panel-server/utils/commands.js's own ACCESS_LEVELS comment.
//
// This is a pin, not a re-derivation from the jar (unlike
// rconRejectionGroundTruth.test.js) -- there's no committed fixture here to
// diff against, just the array itself. A future jar re-verification that
// finds another drift should update BOTH this pin and the array together,
// with the same evidence-first standard the last one used, not just bump
// the number to make the test pass.
const EXPECTED_ACCESS_LEVELS = ["admin", "moderator", "gm", "observer", "priority", "user", "none"];

// The client/server cross-file parity case this file used to guard here
// (apps/panel-client/src/pages/Players.tsx's own hand-maintained ACCESS_LEVELS copy)
// is RETIRED, not just untested: access-levels-should-come-from-the-server-
// not-a-hardcoded-array (2026-08-30) deleted that copy entirely -- Players.tsx
// now fetches GET /players/access-levels and renders whatever it returns, so
// there is no second literal array left to drift out of sync with this one.
// ACCESS_LEVELS itself is still real and still pinned below: it's now the
// server-side fallback that route (and POST /access-level's own validation
// gate) both use when the server's live role table is unavailable (remote
// server, or one that has never started) -- see
// apps/panel-server/tests/playersAccessLevelsRoute.test.js for that route's own
// coverage of the dynamic-list and fallback paths.
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

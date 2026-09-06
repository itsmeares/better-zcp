import { describe, expect, it } from "vitest";

// apps/panel-server/tests/helpers/mockPermissionsDb.js is a THIRD copy of the three
// default role capability lists, deliberately self-contained (no import of
// services/permissions.js) to avoid a circular-mock deadlock when it's used
// inside a vi.mock("../database/init.js", ...) factory -- see that file's
// header comment. This is the (non-mock-factory) cross-check that keeps it
// from silently drifting away from the real DEFAULT_ROLE_CAPABILITIES.

describe("test fixture mockPermissionsDb.js matches services/permissions.js exactly", () => {
  it("admin/technician/moderator capability sets are identical", async () => {
    const { DEFAULT_ROLE_CAPABILITIES } = await import("../services/permissions.js");
    const { TEST_ROLE_CAPABILITIES } = await import("./helpers/mockPermissionsDb.js");

    for (const roleName of ["admin", "technician", "moderator"]) {
      expect(
        TEST_ROLE_CAPABILITIES[roleName].slice().sort(),
        `role "${roleName}": test fixture vs. DEFAULT_ROLE_CAPABILITIES`,
      ).toEqual(DEFAULT_ROLE_CAPABILITIES[roleName].slice().sort());
    }
  });
});

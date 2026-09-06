import { describe, expect, it } from "vitest";


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

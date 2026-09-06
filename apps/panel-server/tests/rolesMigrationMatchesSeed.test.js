import { describe, expect, it } from "vitest";

// apps/panel-server/services/permissions.js's DEFAULT_ROLE_CAPABILITIES and
// database/init.js's migration-v2 capability arrays are two independent
// copies of the same snapshot -- kept separate deliberately to avoid a
// circular import between the two files (see both files' header comments).
// Two independent copies drift silently unless something asserts they
// match; this is that something.

describe("permissions.js DEFAULT_ROLE_CAPABILITIES matches the migration's seed exactly", () => {
  it("admin/technician/moderator capability sets are identical between the two copies", async () => {
    const { DEFAULT_ROLE_CAPABILITIES } = await import("../services/permissions.js");
    const { runMigrations } = await import("../database/init.js");

    const migrated = runMigrations({
      users: [],
      settings: {},
      _schemaVersion: 1,
    });

    const byName = Object.fromEntries(migrated.roles.map((r) => [r.name, r.capabilities]));

    for (const roleName of ["admin", "technician", "moderator"]) {
      expect(
        byName[roleName].slice().sort(),
        `role "${roleName}": migration seed vs. DEFAULT_ROLE_CAPABILITIES`,
      ).toEqual(DEFAULT_ROLE_CAPABILITIES[roleName].slice().sort());
    }
  });

  it("every capability granted by the migration seed is a real, catalogued capability key", async () => {
    const { CAPABILITIES, isKnownCapability } = await import("../services/permissions.js");
    const { runMigrations } = await import("../database/init.js");

    const migrated = runMigrations({ users: [], settings: {}, _schemaVersion: 1 });
    for (const role of migrated.roles) {
      for (const capability of role.capabilities) {
        expect(isKnownCapability(capability), `${role.name} grants unknown capability "${capability}"`).toBe(
          true,
        );
      }
    }
    expect(CAPABILITIES.length).toBeGreaterThan(0);
  });
});

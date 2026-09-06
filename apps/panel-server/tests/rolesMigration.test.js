import { describe, expect, it } from "vitest";

// The migration is the deliverable, not the code (per the brief): an
// existing install must come up with every account able to do exactly
// what it could yesterday, with no operator action. runMigrations() is a
// pure function of `data` -- no I/O -- exercised directly against a plain
// object shaped like a real pre-migration (schema v1) db.json, rather than
// through getDb()'s dataDir, which is resolved once from paths.config.json
// and memoized process-wide for the whole suite, so it isn't practical to
// redirect through getDb() from an individual test file.

const { runMigrations } = await import("../database/init.js");

function makeV1Data(overrides = {}) {
  return {
    users: [
      { id: "u-admin", username: "admin1", role: "admin" },
      { id: "u-tech", username: "tech1", role: "technician" },
      { id: "u-mod", username: "mod1", role: "moderator" },
    ],
    settings: {},
    _schemaVersion: 1,
    ...overrides,
  };
}

describe("database/init.js schema v2 migration: roles collection + user.roleId", () => {
  it("seeds admin/technician/moderator roles and assigns roleId to every existing user, without touching user.role", () => {
    const data = runMigrations(makeV1Data());

    expect(data._schemaVersion).toBe(3);
    expect(Array.isArray(data.roles)).toBe(true);
    expect(data.roles.map((r) => r.name).sort()).toEqual([
      "admin",
      "moderator",
      "technician",
    ]);

    const admin = data.roles.find((r) => r.name === "admin");
    const technician = data.roles.find((r) => r.name === "technician");
    const moderator = data.roles.find((r) => r.name === "moderator");
    expect(admin.isSeeded).toBe(true);
    expect(technician.isSeeded).toBe(true);
    expect(moderator.isSeeded).toBe(true);

    // admin: everything technician and moderator have, plus admin-only ones.
    expect(admin.capabilities).toEqual(expect.arrayContaining(technician.capabilities));
    expect(admin.capabilities).toEqual(expect.arrayContaining(moderator.capabilities));
    expect(admin.capabilities).toEqual(
      expect.arrayContaining([
        "users.manage",
        "roles.manage",
        "backups.restore",
        "server.wipe",
        "servers.discover",
        "bridge.command",
        "diagnostics.manage",
        "panel.settings",
      ]),
    );

    // technician: operational capabilities, none of the admin-only ones.
    expect(technician.capabilities).toEqual(
      expect.arrayContaining([
        "server.control",
        "server.install",
        "server.configure",
        "mods.manage",
      ]),
    );
    expect(technician.capabilities).not.toEqual(
      expect.arrayContaining([
        "users.manage",
        "roles.manage",
        "server.wipe",
        "backups.restore",
      ]),
    );

    // moderator: the players.* trio (matches the single blanket
    // router.use(requireRole(admin,tech,mod)) players.js had before its
    // three-way split) plus server.world_events -- the ~150 routes that
    // were reachable by any signed-in role with NO gate at all (weather,
    // zombie hordes, broadcast messages) were folded in and granted to all
    // three default roles by explicit ruling ("adding a capability is not
    // restricting it"), not narrowed to admin+technician only.
    expect(moderator.capabilities.slice().sort()).toEqual(
      ["players.gm_tools", "players.moderate", "players.view", "server.world_events"].sort(),
    );

    const users = data.users;
    expect(users.find((u) => u.id === "u-admin")).toEqual(
      expect.objectContaining({ role: "admin", roleId: admin.id }),
    );
    expect(users.find((u) => u.id === "u-tech")).toEqual(
      expect.objectContaining({ role: "technician", roleId: technician.id }),
    );
    expect(users.find((u) => u.id === "u-mod")).toEqual(
      expect.objectContaining({ role: "moderator", roleId: moderator.id }),
    );
  });

  it("is a no-op on a db already at the current schema version", () => {
    const alreadyMigrated = {
      users: [{ id: "u1", username: "a", role: "admin", roleId: "role-admin" }],
      roles: [
        { id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true },
      ],
      settings: {},
      _schemaVersion: 3,
    };

    const data = runMigrations(alreadyMigrated);

    expect(data.roles).toHaveLength(1);
    expect(data.roles[0].capabilities).toEqual(["users.manage"]);
  });

  it("re-running the v1->v2 step against already-seeded roles does not duplicate them (idempotent by role id)", () => {
    // Simulates a crash after the in-memory transform but before the
    // version bump was durably written -- the exact scenario the
    // function's own docstring calls out ("safe to re-run if the write
    // after bumping the version failed").
    const partiallyMigrated = runMigrations(makeV1Data());
    partiallyMigrated._schemaVersion = 1; // as if the version bump never made it to disk

    const data = runMigrations(partiallyMigrated);

    expect(data.roles).toHaveLength(3);
    expect(data.roles.map((r) => r.id).sort()).toEqual(
      ["role-admin", "role-moderator", "role-technician"].sort(),
    );
  });

  it("does not overwrite a roleId a user already had before this migration ran", () => {
    const data = runMigrations(
      makeV1Data({
        users: [{ id: "u-custom", username: "x", role: "admin", roleId: "role-some-custom-role" }],
      }),
    );

    expect(data.users[0].roleId).toBe("role-some-custom-role");
  });

  it("leaves user.role completely untouched (dual-write, not a replace)", () => {
    const data = runMigrations(makeV1Data());
    expect(data.users.map((u) => u.role)).toEqual(["admin", "technician", "moderator"]);
  });
});

describe("database/init.js schema v3 migration: backups.download backfill", () => {
  // The exact regression this exists to prevent: an install that already
  // migrated to v2 -- i.e. every real install upgrading to this build --
  // has its roles frozen at whatever v2 seeded them with. GET /download
  // went from ungated to requiring backups.download in the same release;
  // without this migration, an existing technician role would silently
  // lose an ability it already had (the route was unguarded), with no
  // explanation. Fixtures here start at _schemaVersion: 2 on purpose --
  // that is the real-world starting point this migration has to handle,
  // not a fresh v1 install (which the v2 seed already covers directly).

  it("grants backups.download to an existing role that already holds backups.manage", () => {
    const data = runMigrations({
      users: [],
      roles: [
        {
          id: "role-technician",
          name: "technician",
          capabilities: ["backups.manage", "server.control"],
          isSeeded: true,
        },
      ],
      settings: {},
      _schemaVersion: 2,
    });

    expect(data._schemaVersion).toBe(3);
    const technician = data.roles.find((r) => r.id === "role-technician");
    expect(technician.capabilities).toEqual(
      expect.arrayContaining(["backups.manage", "backups.download", "server.control"]),
    );
  });

  it("does the same for a CUSTOM role an operator built themselves, not just the seeded ones", () => {
    const data = runMigrations({
      users: [],
      roles: [
        {
          id: "role-custom-housekeeper",
          name: "housekeeper",
          capabilities: ["backups.manage"],
          isSeeded: false,
        },
      ],
      settings: {},
      _schemaVersion: 2,
    });

    const custom = data.roles.find((r) => r.id === "role-custom-housekeeper");
    expect(custom.capabilities).toContain("backups.download");
  });

  it("does NOT grant it to a role that never held backups.manage -- that gap is the fix, not a bug", () => {
    const data = runMigrations({
      users: [],
      roles: [
        {
          id: "role-moderator",
          name: "moderator",
          capabilities: ["players.moderate", "players.view"],
          isSeeded: true,
        },
      ],
      settings: {},
      _schemaVersion: 2,
    });

    const moderator = data.roles.find((r) => r.id === "role-moderator");
    expect(moderator.capabilities).not.toContain("backups.download");
  });

  it("is idempotent -- re-running does not duplicate the entry for a role that already has it", () => {
    const once = runMigrations({
      users: [],
      roles: [
        { id: "role-technician", name: "technician", capabilities: ["backups.manage"], isSeeded: true },
      ],
      settings: {},
      _schemaVersion: 2,
    });
    once._schemaVersion = 2; // as if the version bump never made it to disk
    const twice = runMigrations(once);

    const technician = twice.roles.find((r) => r.id === "role-technician");
    expect(technician.capabilities.filter((c) => c === "backups.download")).toHaveLength(1);
  });
});

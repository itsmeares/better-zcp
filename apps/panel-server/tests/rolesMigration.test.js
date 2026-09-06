import { describe, expect, it } from "vitest";


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
    const partiallyMigrated = runMigrations(makeV1Data());
    partiallyMigrated._schemaVersion = 1;

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
    once._schemaVersion = 2;
    const twice = runMigrations(once);

    const technician = twice.roles.find((r) => r.id === "role-technician");
    expect(technician.capabilities.filter((c) => c === "backups.download")).toHaveLength(1);
  });
});

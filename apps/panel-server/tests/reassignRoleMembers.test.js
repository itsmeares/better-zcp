import { afterEach, beforeEach, describe, expect, it } from "vitest";


const { getDb, reassignRoleMembers } = await import("../database/init.js");

let db;

beforeEach(async () => {
  db = await getDb();
  db.data.users = [];
  db.data.roles = [];
});

afterEach(() => {
  db.data.users = [];
  db.data.roles = [];
});

describe("reassignRoleMembers", () => {
  it("updates user.role to the target's exact name for a CUSTOM (non-seeded) target -- the branch the bug was in", async () => {
    const fromRole = { id: "role-old", name: "old-role", isSeeded: false };
    const toRole = { id: "role-custom", name: "Event Runner", isSeeded: false };
    db.data.users.push({ id: "u1", role: "old-role", roleId: "role-old" });

    const count = await reassignRoleMembers(fromRole, toRole);

    expect(count).toBe(1);
    expect(db.data.users[0]).toEqual(
      expect.objectContaining({ roleId: "role-custom", role: "Event Runner" }),
    );
  });

  it("updates user.role to the target's exact name for a SEEDED target too (must not regress the case that already worked)", async () => {
    const fromRole = { id: "role-custom", name: "Event Runner", isSeeded: false };
    const toRole = { id: "role-technician", name: "technician", isSeeded: true };
    db.data.users.push({ id: "u1", role: "Event Runner", roleId: "role-custom" });

    await reassignRoleMembers(fromRole, toRole);

    expect(db.data.users[0]).toEqual(
      expect.objectContaining({ roleId: "role-technician", role: "technician" }),
    );
  });

  it("matches members of a seeded fromRole by name when roleId isn't set (pre-migration-style user record)", async () => {
    const fromRole = { id: "role-moderator", name: "moderator", isSeeded: true };
    const toRole = { id: "role-custom", name: "Trusted Helper", isSeeded: false };
    db.data.users.push({ id: "u1", role: "moderator" });

    const count = await reassignRoleMembers(fromRole, toRole);

    expect(count).toBe(1);
    expect(db.data.users[0]).toEqual(
      expect.objectContaining({ roleId: "role-custom", role: "Trusted Helper" }),
    );
  });

  it("does not touch a user who isn't a member of fromRole", async () => {
    const fromRole = { id: "role-old", name: "old-role", isSeeded: false };
    const toRole = { id: "role-custom", name: "Event Runner", isSeeded: false };
    db.data.users.push({ id: "u1", role: "admin", roleId: "role-admin" });

    const count = await reassignRoleMembers(fromRole, toRole);

    expect(count).toBe(0);
    expect(db.data.users[0]).toEqual(
      expect.objectContaining({ roleId: "role-admin", role: "admin" }),
    );
  });
});

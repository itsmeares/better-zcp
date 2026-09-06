import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Real database/init.js, not mocked -- Kevin found reassignRoleMembers only
// updated user.role when the TARGET role was seeded, leaving it stale for a
// custom one. That mattered because requirePermission() resolves
// capabilities via getRoleByName(req.user.role), not roleId (roleId is
// dual-written but read by nothing yet) -- a stale .role meant every
// request from a reassigned user kept authorizing against their OLD role
// indefinitely. A test with only a seeded target proves nothing: that's
// exactly the branch that was already correct. This one uses a CUSTOM
// target specifically, the branch the bug was actually in.
//
// Exercised against the real, shared getDb() (same pattern as
// circuitBreakerStatus.test.js / db-tmp-cleanup.test.js) rather than
// mocked, because the two permissions-service test files' own mocks of
// this function independently reimplemented the SAME bug (only setting
// .role for a seeded target) and neither ever asserted on .role after
// reassignment -- a mocked test cannot catch a bug in the mock's own
// assumptions about the thing it's replacing.

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
    db.data.users.push({ id: "u1", role: "moderator" }); // no roleId at all

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

import { beforeEach, describe, expect, it, vi } from "vitest";

// updateRole()/deleteRole() each look up the role once at the top (getRoles/
// getRoleById), then write via replaceRoleById()/removeRoleById() much
// later, after capability validation and lockout-rule checks. Those two
// database/init.js functions re-check existence at write time against a
// fresh getDb() read and return null/false if the role is gone by then --
// database/init.js:1962-1970 and :1972-1980 -- independent of what the
// earlier lookup in this same request saw. A second, concurrent request
// deleting the same role in that window used to be silently discarded: the
// caller still reported "role updated"/"role deleted" even though the write
// found nothing to change. These tests force exactly that: the role is still
// present for the initial lookup (so every earlier check in updateRole/
// deleteRole passes normally), but the write call is made to report a miss,
// as a genuinely concurrent second request's write would. They fail against
// the pre-fix code (which discarded the write's return value) and pass now
// that updateRole/deleteRole check it.

const rolesById = new Map();

function seedRole(id, name, capabilities) {
  rolesById.set(id, { id, name, capabilities, isSeeded: false });
}

const { replaceRoleById, removeRoleById } = vi.hoisted(() => ({
  replaceRoleById: vi.fn(),
  removeRoleById: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getDb: async () => ({ data: { users: [] } }),
  commitNow: async () => {},
  getRoles: async () => Array.from(rolesById.values()),
  getRoleById: async (id) => rolesById.get(String(id)) || null,
  getRoleByName: async (name) =>
    Array.from(rolesById.values()).find((r) => r.name === name) || null,
  insertRole: async (role) => {
    rolesById.set(role.id, role);
    return role;
  },
  replaceRoleById,
  removeRoleById,
  getUsersForRole: async () => [],
  getUsersForRoleAccounting: async () => [],
  reassignRoleMembers: async () => 0,
}));

const { updateRole, deleteRole } = await import("../services/permissions.js");

beforeEach(() => {
  rolesById.clear();
  // Default: real database/init.js semantics (write succeeds and returns
  // the new value / true) so tests that aren't exercising the race still
  // behave normally without repeating this wiring in each one.
  replaceRoleById.mockReset().mockImplementation(async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  });
  removeRoleById.mockReset().mockImplementation(async (id) => rolesById.delete(String(id)));
});

describe("updateRole vs. concurrent delete of the same role", () => {
  it("throws ROLE_NOT_FOUND instead of reporting success when the write finds the role already gone", async () => {
    seedRole("role-a", "Custom", ["players.view"]);
    // Role is still present for updateRole's own lookup -- every check up to
    // the write passes normally -- but the write itself reports the
    // real-world "someone else deleted it first" outcome.
    replaceRoleById.mockResolvedValueOnce(null);

    await expect(
      updateRole("role-a", { capabilities: ["players.view", "players.gm_tools"] }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("still succeeds and actually persists when nothing raced it", async () => {
    seedRole("role-a", "Custom", ["players.view"]);

    const updated = await updateRole("role-a", { capabilities: ["players.view"] });

    expect(updated.capabilities).toEqual(["players.view"]);
    expect(rolesById.get("role-a").capabilities).toEqual(["players.view"]);
  });
});

describe("deleteRole vs. a second, concurrent delete of the same role", () => {
  it("throws ROLE_NOT_FOUND instead of reporting deleted:true when the write finds nothing to remove", async () => {
    seedRole("role-a", "Custom", ["players.view"]);
    removeRoleById.mockResolvedValueOnce(false);

    await expect(deleteRole("role-a")).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("still succeeds when the role genuinely exists", async () => {
    seedRole("role-a", "Custom", ["players.view"]);

    const result = await deleteRole("role-a");

    expect(result).toEqual({ deleted: true, reassigned: 0, reassignedTo: null });
    expect(rolesById.has("role-a")).toBe(false);
  });
});

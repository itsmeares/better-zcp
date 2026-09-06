import { beforeEach, describe, expect, it, vi } from "vitest";


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
  replaceRoleById.mockReset().mockImplementation(async (id, role) => {
    rolesById.set(String(id), role);
    return role;
  });
  removeRoleById.mockReset().mockImplementation(async (id) => rolesById.delete(String(id)));
});

describe("updateRole vs. concurrent delete of the same role", () => {
  it("throws ROLE_NOT_FOUND instead of reporting success when the write finds the role already gone", async () => {
    seedRole("role-a", "Custom", ["players.view"]);
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

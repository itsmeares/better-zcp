import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, unknown>();
const db = { data: { users: [] as any[], roles: [] as any[] } };

vi.mock("../database/init.ts", () => ({
  getSetting: async (key: string) => settings.get(key) ?? null,
  setSetting: async (key: string, value: unknown) => settings.set(key, value),
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id: string | number) =>
    db.data.roles.find((role) => String(role.id) === String(id)) || null,
  getRoleByName: async (name: string) =>
    db.data.roles.find((role) => role.name === name) || null,
  getUsersForRole: async (role: any) =>
    db.data.users.filter(
      (user) => user.roleId === role.id || (role.isSeeded && user.role === role.name),
    ),
}));

const { default: authService } = await import("../services/auth.ts");
const { evictRevokedSockets, io } = await import("../index.ts");

const ADMIN_ROLE = {
  id: "role-admin",
  name: "admin",
  capabilities: ["users.manage", "roles.manage", "server.control"],
  isSeeded: true,
};
const TECHNICIAN_ROLE = {
  id: "role-technician",
  name: "technician",
  capabilities: ["server.control", "backups.manage"],
  isSeeded: true,
};

function resetWith(users = [{
  id: "u-tech",
  username: "tech",
  role: "technician",
  roleId: "role-technician",
  tokenGen: 0,
  password: bcrypt.hashSync("current-password", 4),
}]) {
  settings.clear();
  db.data.roles = [ADMIN_ROLE, TECHNICIAN_ROLE].map((role) => ({ ...role }));
  db.data.users = users.map((user) => ({ ...user }));
  authService.jwtSecret = "test-socket-revocation-secret";
}

describe("Socket.IO session revocation wiring", () => {
  let disconnectSocketsSpy: ReturnType<typeof vi.spyOn>;
  let roomDisconnectSpy: ReturnType<typeof vi.fn>;
  let inSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWith();
    disconnectSocketsSpy = vi
      .spyOn(io, "disconnectSockets")
      .mockImplementation(() => io);
    roomDisconnectSpy = vi.fn();
    inSpy = vi.spyOn(io, "in").mockReturnValue({
      disconnectSockets: roomDisconnectSpy,
    } as any);
  });

  afterEach(() => {
    disconnectSocketsSpy.mockRestore();
    inSpy.mockRestore();
  });

  it("evicts only the changed user's sockets after a password change", async () => {
    await authService.changePassword("u-tech", "current-password", "new-password");

    expect(inSpy).toHaveBeenCalledWith("user:u-tech");
    expect(roomDisconnectSpy).toHaveBeenCalledWith(true);
    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
  });

  it("evicts the affected user's sockets for reset, role change, deletion, and logout", async () => {
    await authService.resetPassword("new-reset-password");
    expect(inSpy).toHaveBeenLastCalledWith("user:u-tech");

    resetWith();
    await authService.changeUserRoleById("u-tech", "role-admin");
    expect(inSpy).toHaveBeenLastCalledWith("user:u-tech");

    resetWith();
    await authService.deleteUser("u-tech", { actingUserId: "u-admin" });
    expect(inSpy).toHaveBeenLastCalledWith("user:u-tech");

    resetWith();
    const user = db.data.users[0];
    const session = authService.createRefreshSession(user);
    const refreshToken = authService.generateRefreshToken(user, session.id);
    await expect(authService.logout(refreshToken)).resolves.toBe(true);
    expect(inSpy).toHaveBeenLastCalledWith("user:u-tech");
  });

  it("can evict every socket for a signing-key rotation", () => {
    evictRevokedSockets({ scope: "all" });

    expect(disconnectSocketsSpy).toHaveBeenCalledWith(true);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("ignores incomplete or unknown revocation events", () => {
    expect(() => evictRevokedSockets({ scope: "user" } as any)).not.toThrow();

    expect(disconnectSocketsSpy).not.toHaveBeenCalled();
    expect(inSpy).not.toHaveBeenCalled();
  });
});

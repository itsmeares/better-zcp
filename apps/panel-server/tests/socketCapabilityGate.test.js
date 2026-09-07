import { describe, expect, it, vi } from "vitest";


const { getRoleByNameMock } = vi.hoisted(() => ({
  getRoleByNameMock: vi.fn(),
}));

vi.mock("../database/init.ts", () => ({
  getRoleByName: getRoleByNameMock,
  getDb: vi.fn(async () => ({ data: {} })),
}));

const { socketHasCapability } = await import("../index.ts");

describe("socketHasCapability() -- Socket.IO's capability gate for subscribe:* rooms", () => {
  it("returns false with no socket.user at all (unauthenticated / pre-setup connection)", async () => {
    getRoleByNameMock.mockClear();
    const result = await socketHasCapability({}, "diagnostics.manage");
    expect(result).toBe(false);
    expect(getRoleByNameMock).not.toHaveBeenCalled();
  });

  it("returns true when the socket's role holds the capability", async () => {
    getRoleByNameMock.mockResolvedValueOnce({
      name: "technician",
      capabilities: ["diagnostics.manage", "server.control"],
    });
    const socket = { user: { role: "technician" } };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(true);
    expect(getRoleByNameMock).toHaveBeenCalledWith("technician");
  });

  it("returns false when the socket's role exists but lacks the capability -- the moderator/diagnostics.manage case that was exploitable", async () => {
    getRoleByNameMock.mockResolvedValueOnce({
      name: "moderator",
      capabilities: ["players.moderate", "players.gm_tools", "players.view", "server.world_events"],
    });
    const socket = { user: { role: "moderator" } };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(false);
  });

  it("returns false when the role cannot be resolved (renamed/deleted role, or DB lookup returns null) -- fails closed, not open", async () => {
    getRoleByNameMock.mockResolvedValueOnce(null);
    const socket = { user: { role: "some-deleted-role" } };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(false);
  });

  it("returns false, not a thrown error, when the role lookup itself throws", async () => {
    getRoleByNameMock.mockRejectedValueOnce(new Error("db unavailable"));
    const socket = { user: { role: "admin" } };
    await expect(socketHasCapability(socket, "diagnostics.manage")).resolves.toBe(false);
  });

  it("the auth-disabled sentinel role (admin, authDisabled:true) resolves like any other admin socket", async () => {
    getRoleByNameMock.mockResolvedValueOnce({
      name: "admin",
      capabilities: ["diagnostics.manage", "players.view", "server.control"],
    });
    const socket = {
      user: { userId: null, username: null, role: "admin", tokenGen: null, authDisabled: true },
    };
    expect(await socketHasCapability(socket, "diagnostics.manage")).toBe(true);
  });
});

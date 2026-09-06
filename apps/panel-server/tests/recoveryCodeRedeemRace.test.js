import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-ins so the real service logic (including bcrypt) runs
// without touching the panel database. Mirrors recoveryCodes.test.js's setup.
const settings = new Map();
const db = { data: { users: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

const { default: authService } = await import("../services/auth.js");

// redeemRecoveryCode() reads the stored code list, finds an unused match,
// resets the password (a real bcrypt.hash — genuinely slow, ~150-300ms at
// BCRYPT_ROUNDS=12, plenty of room for two calls to interleave), THEN marks
// the code used and writes the list back. Unlike createUser/
// changeUserRoleById/deleteUser/bootstrapAdminFromExternalIdentity (all of
// which wrap this same read-check-write shape in this._withMutex, per the
// constructor's own comment: "Serializes setup/createUser to prevent a race
// where two concurrent /api/auth/setup requests both pass the needsSetup()
// check"), redeemRecoveryCode() does not serialize against itself. Two
// concurrent redemptions of the SAME code each fetch their own independent
// parse of the stored entries (JSON.parse — not a shared reference), so
// neither sees the other's not-yet-written usedAt mark: both pass the
// "is this code still valid" check and both successfully reset the
// password, defeating "each code works exactly once" -- exactly the shape
// of race _withMutex exists to close elsewhere in this file.
describe("redeemRecoveryCode: concurrent redemption of the same code", () => {
  beforeEach(() => {
    settings.clear();
    db.data.users = [
      {
        id: 1,
        username: "admin",
        role: "admin",
        password: "unset",
        tokenGen: 0,
        refreshSessions: [],
      },
    ];
  });

  it("only lets ONE of two simultaneous redemptions of the same code succeed", async () => {
    const { codes } = await authService.generateRecoveryCodes(1);
    const code = codes[0];

    const [a, b] = await Promise.allSettled([
      authService.redeemRecoveryCode(code, "password-from-request-A"),
      authService.redeemRecoveryCode(code, "password-from-request-B"),
    ]);

    const succeeded = [a, b].filter((r) => r.status === "fulfilled");
    const failed = [a, b].filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.message).toMatch(/not valid or has already been used/);

    const status = await authService.getRecoveryCodeStatus();
    expect(status.remaining).toBe(0);
  });
});

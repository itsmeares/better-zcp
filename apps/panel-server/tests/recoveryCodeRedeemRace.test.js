import { describe, it, expect, beforeEach, vi } from "vitest";

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

const { default: authService } = await import("../services/auth.ts");

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

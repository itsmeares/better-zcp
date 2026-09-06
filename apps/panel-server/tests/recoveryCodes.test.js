import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-ins so the real service logic (including bcrypt) runs without
// touching the panel database.
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

describe("recovery codes", () => {
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

  it("returns codes once and stores only hashes", async () => {
    const { codes } = await authService.generateRecoveryCodes(5);
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);

    const stored = settings.get("authRecoveryCodes");
    for (const code of codes) {
      expect(stored).not.toContain(code);
    }
  });

  it("reports remaining count", async () => {
    await authService.generateRecoveryCodes(3);
    const status = await authService.getRecoveryCodeStatus();
    expect(status).toMatchObject({ configured: true, remaining: 3, total: 3 });
  });

  it("redeems a valid code and sets the new password", async () => {
    const { codes } = await authService.generateRecoveryCodes(3);
    const result = await authService.redeemRecoveryCode(codes[1], "brand-new-pass");
    expect(result.username).toBe("admin");
    expect(result.remaining).toBe(2);
    expect(db.data.users[0].password).not.toBe("unset");
  });

  it("burns a code so it cannot be reused", async () => {
    const { codes } = await authService.generateRecoveryCodes(2);
    await authService.redeemRecoveryCode(codes[0], "first-password");
    await expect(
      authService.redeemRecoveryCode(codes[0], "second-password"),
    ).rejects.toThrow(/not valid or has already been used/);
  });

  it("accepts codes case-insensitively", async () => {
    const { codes } = await authService.generateRecoveryCodes(1);
    const result = await authService.redeemRecoveryCode(
      codes[0].toLowerCase(),
      "another-password",
    );
    expect(result.username).toBe("admin");
  });

  it("rejects an unknown code without changing the password", async () => {
    await authService.generateRecoveryCodes(2);
    await expect(
      authService.redeemRecoveryCode("AAAAA-BBBBB-CCCCC", "should-not-apply"),
    ).rejects.toThrow();
    expect(db.data.users[0].password).toBe("unset");
  });

  it("rejects redemption when no codes exist", async () => {
    await expect(
      authService.redeemRecoveryCode("AAAAA-BBBBB-CCCCC", "irrelevant"),
    ).rejects.toThrow(/No recovery codes have been generated/);
  });

  it("invalidates old codes when new ones are generated", async () => {
    const first = await authService.generateRecoveryCodes(3);
    await authService.generateRecoveryCodes(3);
    await expect(
      authService.redeemRecoveryCode(first.codes[0], "no-longer-valid"),
    ).rejects.toThrow(/not valid or has already been used/);
  });

  it("still enforces the password policy", async () => {
    const { codes } = await authService.generateRecoveryCodes(1);
    await expect(
      authService.redeemRecoveryCode(codes[0], "123"),
    ).rejects.toThrow(/at least 6 characters/);
  });
});

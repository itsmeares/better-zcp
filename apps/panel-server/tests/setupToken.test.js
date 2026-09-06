import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake settings store — the module under test only ever calls
// getSetting/setSetting with the single key "setupToken", so a plain object
// stands in for the real lowdb-backed store without touching the filesystem.
let store;
vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => store[key] ?? null),
  setSetting: vi.fn(async (key, value) => {
    store[key] = value;
  }),
}));

const {
  getOrCreateSetupToken,
  logSetupTokenIfNeeded,
  verifySetupToken,
  clearSetupToken,
} = await import("../utils/setupToken.js");

describe("setupToken", () => {
  beforeEach(() => {
    store = {};
    delete process.env.SETUP_TOKEN;
  });

  afterEach(() => {
    delete process.env.SETUP_TOKEN;
  });

  describe("getOrCreateSetupToken", () => {
    it("generates a strong token on first call and persists it", async () => {
      const token = await getOrCreateSetupToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex = 256 bits
      expect(store.setupToken).toBe(token);
    });

    it("returns the SAME token on a later call rather than regenerating it", async () => {
      const first = await getOrCreateSetupToken();
      const second = await getOrCreateSetupToken();
      expect(second).toBe(first);
    });

    it("prefers an operator-supplied SETUP_TOKEN env var and never persists it", async () => {
      process.env.SETUP_TOKEN = "operator-chosen-value";
      const token = await getOrCreateSetupToken();
      expect(token).toBe("operator-chosen-value");
      expect(store.setupToken).toBeUndefined();
    });

    it("trims whitespace from an env-supplied token", async () => {
      process.env.SETUP_TOKEN = "  padded-value  \n";
      const token = await getOrCreateSetupToken();
      expect(token).toBe("padded-value");
    });

    it("falls back to the persisted token when SETUP_TOKEN is blank", async () => {
      process.env.SETUP_TOKEN = "   ";
      const generated = await getOrCreateSetupToken();
      expect(generated).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("verifySetupToken", () => {
    it("accepts the correct token", async () => {
      const token = await getOrCreateSetupToken();
      expect(await verifySetupToken(token)).toBe(true);
    });

    it("rejects a wrong token of the same length", async () => {
      const token = await getOrCreateSetupToken();
      const wrong = "0".repeat(token.length);
      expect(await verifySetupToken(wrong)).toBe(false);
    });

    it("rejects a wrong-length token without throwing", async () => {
      await getOrCreateSetupToken();
      await expect(verifySetupToken("short")).resolves.toBe(false);
    });

    it("rejects empty, null, and non-string candidates without throwing", async () => {
      await getOrCreateSetupToken();
      expect(await verifySetupToken("")).toBe(false);
      expect(await verifySetupToken(null)).toBe(false);
      expect(await verifySetupToken(undefined)).toBe(false);
      expect(await verifySetupToken(12345)).toBe(false);
    });

    it("verifies against an operator-supplied SETUP_TOKEN", async () => {
      process.env.SETUP_TOKEN = "operator-chosen-value";
      expect(await verifySetupToken("operator-chosen-value")).toBe(true);
      expect(await verifySetupToken("wrong-value-here")).toBe(false);
    });
  });

  describe("logSetupTokenIfNeeded", () => {
    it("does NOT log or generate a token when setup is already complete", async () => {
      const loggerInstance = { warn: vi.fn() };
      await logSetupTokenIfNeeded(false, loggerInstance);
      expect(loggerInstance.warn).not.toHaveBeenCalled();
      expect(store.setupToken).toBeUndefined();
    });

    it("logs the actual token value when setup is pending", async () => {
      const loggerInstance = { warn: vi.fn() };
      await logSetupTokenIfNeeded(true, loggerInstance);
      expect(loggerInstance.warn).toHaveBeenCalledTimes(1);
      const message = loggerInstance.warn.mock.calls[0][0];
      expect(message).toContain(store.setupToken);
    });
  });

  describe("clearSetupToken", () => {
    it("removes the persisted token so a stale value cannot linger", async () => {
      await getOrCreateSetupToken();
      expect(store.setupToken).toBeTruthy();
      await clearSetupToken();
      expect(store.setupToken).toBeNull();
    });
  });
});

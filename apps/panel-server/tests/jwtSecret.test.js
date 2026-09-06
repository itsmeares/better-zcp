import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Same "declare the mutable state before vi.mock, mutate it in beforeEach"
// pattern as setupTokenGate.test.js's db/settings mocks — the factory
// doesn't run until the mocked module is first imported below, by which
// point tmpDir already has a value.
let tmpDir;

vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir }),
}));

const { loadOrCreateJwtSecret, getJwtSecretPath, regenerateJwtSecretFile } =
  await import("../utils/jwtSecret.js");

describe("loadOrCreateJwtSecret", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtsecret-"));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_FILE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fresh install (no env, no file, no legacy value) generates and persists a new key", async () => {
    const result = await loadOrCreateJwtSecret({ legacyValue: null });
    expect(result.source).toBe("generated");
    expect(result.secret).toMatch(/^[0-9a-f]{128}$/);
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(result.secret);
  });

  it("existing install: a legacy db.json value with no file yet migrates VERBATIM, not a fresh key", async () => {
    const legacy = "legacy-secret-from-db-json-abc123";
    const result = await loadOrCreateJwtSecret({ legacyValue: legacy });
    expect(result.source).toBe("migrated");
    expect(result.secret).toBe(legacy);
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(legacy);
  });

  it("a token signed before migration still verifies after it — same bytes, not a rotation", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const legacy = "legacy-secret-that-already-signed-real-tokens";
    const tokenSignedBeforeMigration = jwt.sign({ userId: "u1" }, legacy);

    const result = await loadOrCreateJwtSecret({ legacyValue: legacy });

    expect(() =>
      jwt.verify(tokenSignedBeforeMigration, result.secret),
    ).not.toThrow();
  });

  it("file already exists: loads it as-is and ignores any legacy value passed in (steady-state restart)", async () => {
    fs.writeFileSync(getJwtSecretPath(), "existing-file-secret", {
      mode: 0o600,
    });
    const result = await loadOrCreateJwtSecret({
      legacyValue: "some-other-legacy-value",
    });
    expect(result.source).toBe("file");
    expect(result.secret).toBe("existing-file-secret");
  });

  it("JWT_SECRET env override wins over the file and the file is left untouched", async () => {
    // 32+ chars -- long enough to clear MIN_JWT_SECRET_LENGTH; this test is
    // about override precedence, not the length guard (see its own
    // describe block below).
    process.env.JWT_SECRET = "env-secret-value-that-is-long-enough-32";
    fs.writeFileSync(getJwtSecretPath(), "file-secret-value", {
      mode: 0o600,
    });
    const result = await loadOrCreateJwtSecret({
      legacyValue: "legacy-value",
    });
    expect(result.source).toBe("env");
    expect(result.secret).toBe("env-secret-value-that-is-long-enough-32");
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(
      "file-secret-value",
    );
  });

  it("JWT_SECRET_FILE env override (Docker/K8s secret mount) also wins", async () => {
    const secretFilePath = path.join(tmpDir, "mounted-secret");
    fs.writeFileSync(secretFilePath, "mounted-secret-value-that-is-long-enough\n");
    process.env.JWT_SECRET_FILE = secretFilePath;
    const result = await loadOrCreateJwtSecret({ legacyValue: null });
    expect(result.source).toBe("env");
    expect(result.secret).toBe("mounted-secret-value-that-is-long-enough");
  });

  it("JWT_SECRET shorter than the minimum is REFUSED, not silently accepted (2026-08-29, auth/sessions hunt low-priority follow-up)", async () => {
    process.env.JWT_SECRET = "x";
    await expect(loadOrCreateJwtSecret({})).rejects.toThrow(
      /only 1 characters.*at least 32/is,
    );
    // Never fell through to generate/persist a file-based key either --
    // the env value is what's wrong; the fix is a better env value, not a
    // silently-substituted one.
    expect(fs.existsSync(getJwtSecretPath())).toBe(false);
  });

  it("JWT_SECRET_FILE content shorter than the minimum is ALSO refused -- the guard is on the resolved value, not just the plain env var", async () => {
    const secretFilePath = path.join(tmpDir, "short-mounted-secret");
    fs.writeFileSync(secretFilePath, "too-short\n");
    process.env.JWT_SECRET_FILE = secretFilePath;
    await expect(loadOrCreateJwtSecret({})).rejects.toThrow(/at least 32/i);
  });

  it("positive control: exactly 32 characters is accepted -- proves the boundary is >= 32, not > 32", async () => {
    process.env.JWT_SECRET = "a".repeat(32);
    const result = await loadOrCreateJwtSecret({});
    expect(result.source).toBe("env");
    expect(result.secret).toBe("a".repeat(32));
  });

  it("31 characters -- one under the boundary -- is refused, proving the boundary is exact, not approximate", async () => {
    process.env.JWT_SECRET = "a".repeat(31);
    await expect(loadOrCreateJwtSecret({})).rejects.toThrow(/at least 32/i);
  });

  // god's explicit ask: these two must not share a branch.
  it("file ABSENT (no legacy, no env) -> generates", async () => {
    expect(fs.existsSync(getJwtSecretPath())).toBe(false);
    const result = await loadOrCreateJwtSecret({});
    expect(result.source).toBe("generated");
  });

  it("file PRESENT but unreadable (a directory sits at the path) -> REFUSES, never generates", async () => {
    fs.mkdirSync(getJwtSecretPath());
    await expect(loadOrCreateJwtSecret({})).rejects.toThrow(
      /could not be read/i,
    );
    // Still a directory afterward — nothing silently overwrote it with a
    // freshly generated key.
    expect(fs.statSync(getJwtSecretPath()).isDirectory()).toBe(true);
  });

  it("file PRESENT but empty -> REFUSES, never generates", async () => {
    fs.writeFileSync(getJwtSecretPath(), "");
    await expect(loadOrCreateJwtSecret({})).rejects.toThrow(/empty/i);
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe("");
  });

  it("file PRESENT but whitespace-only -> treated as empty, REFUSES", async () => {
    fs.writeFileSync(getJwtSecretPath(), "   \n\t  ");
    await expect(loadOrCreateJwtSecret({})).rejects.toThrow(/empty/i);
  });
});

describe("regenerateJwtSecretFile", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-jwtsecret-regen-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("overwrites the file with a brand new value, different from the old one", () => {
    fs.writeFileSync(getJwtSecretPath(), "old-secret-value", { mode: 0o600 });
    const result = regenerateJwtSecretFile();
    expect(result.secret).not.toBe("old-secret-value");
    expect(result.secret).toMatch(/^[0-9a-f]{128}$/);
    expect(fs.readFileSync(getJwtSecretPath(), "utf8")).toBe(result.secret);
  });

  it("a token signed with the old value no longer verifies against the new one", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    fs.writeFileSync(getJwtSecretPath(), "old-secret-value", { mode: 0o600 });
    const oldToken = jwt.sign({ userId: "u1" }, "old-secret-value");

    const result = regenerateJwtSecretFile();

    expect(() => jwt.verify(oldToken, result.secret)).toThrow();
  });
});

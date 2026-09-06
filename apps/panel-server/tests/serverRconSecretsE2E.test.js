import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

// Real (unmocked) database/init.js and utils/paths.js — same precedent as
// db-tmp-cleanup.test.js: the suite's globalSetup already redirects dataDir
// into an isolated temp root for the whole run, so exercising the real
// fs-backed write/read pipeline here is safe.
//
// This is the test god specifically asked for: not "the secret left
// db.json" in isolation, but that the EXISTING masked-placeholder flow in
// routes/servers.js (save real value -> GET shows masked -> PATCH an
// unrelated field with the masked placeholder echoed back -> the real
// value must survive, not become the literal mask string) keeps working
// once rconPassword is redacted at the disk-serialization boundary. This
// file doesn't re-drive routes/servers.js's HTTP layer (its own tests
// already cover the isMaskedSecret skip-write logic in memory, untouched
// by this change) — it proves the thing THAT layer can't see: what
// actually lands on disk, and what actually comes back, across repeated
// real commitNow() cycles.
const { getDb, commitNow, deleteServer } = await import(
  "../database/init.js"
);
const { getDataPaths } = await import("../utils/paths.js");

const { dataDir, dbPath } = getDataPaths();

function readRawDbJson() {
  return fs.readFileSync(dbPath, "utf8");
}

function readServerSecretFile(serverId) {
  return fs.readFileSync(
    path.join(dataDir, "server-secrets", `${serverId}.secret`),
    "utf8",
  );
}

describe("rconPassword end-to-end through the real database/init.js write/read pipeline", () => {
  const serverId = `e2e-test-server-${Date.now()}`;

  afterAll(async () => {
    // Leave the shared isolated dataDir the way this test found it.
    await deleteServer(serverId);
  });

  it("a real password survives create, an unrelated-field update, and never appears on disk", async () => {
    const db = await getDb();

    // ── "create" — mirrors what routes/servers.js's POST handler ends up
    // doing to db.data.servers: a real plaintext password, in memory.
    db.data.servers.push({
      id: serverId,
      name: "E2E RCON Test Server",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "correct-horse-battery-staple",
      isActive: false,
    });
    await commitNow();

    // The disk-safety proof: the real password must not appear anywhere in
    // the raw db.json bytes, in any form.
    expect(readRawDbJson()).not.toContain("correct-horse-battery-staple");
    // And it must be recoverable from its own file — this is not just
    // "gone", it's "moved."
    expect(readServerSecretFile(serverId)).toBe(
      "correct-horse-battery-staple",
    );
    // The in-memory object routes/servers.js's masking layer actually
    // serializes for a GET response still has the real value — masking
    // happens at the API-response boundary (sanitizeServerResponse), not
    // by the value being gone from memory.
    const server = db.data.servers.find((s) => s.id === serverId);
    expect(server.rconPassword).toBe("correct-horse-battery-staple");

    // ── "reopen settings, change an unrelated field, save again" —
    // routes/servers.js's isMaskedSecret check means a client echoing the
    // masked placeholder back never reaches this line; only a genuinely
    // NEW value or an unrelated-field-only update does. Simulate the
    // unrelated-field-only case: rconPassword is untouched in memory,
    // some other field changes, commit again.
    server.name = "E2E RCON Test Server (renamed)";
    await commitNow();

    // The password must be EXACTLY the original value — not the mask
    // string, not corrupted, not silently dropped by a second write cycle
    // through the redaction path.
    expect(server.rconPassword).toBe("correct-horse-battery-staple");
    expect(readServerSecretFile(serverId)).toBe(
      "correct-horse-battery-staple",
    );
    expect(readRawDbJson()).not.toContain("correct-horse-battery-staple");
    // Confirms the field genuinely changed and this wasn't a no-op commit.
    expect(readRawDbJson()).toContain("E2E RCON Test Server (renamed)");

    // ── a REAL password change — operator types a genuinely new one.
    server.rconPassword = "a-brand-new-real-password";
    await commitNow();

    expect(readServerSecretFile(serverId)).toBe("a-brand-new-real-password");
    expect(readRawDbJson()).not.toContain("a-brand-new-real-password");
    expect(readRawDbJson()).not.toContain("correct-horse-battery-staple");
  });

  it("deleting the server removes its password file — nothing orphaned behind it", async () => {
    const db = await getDb();
    const tempId = `e2e-delete-test-${Date.now()}`;
    db.data.servers.push({
      id: tempId,
      name: "To be deleted",
      rconPassword: "will-be-deleted",
    });
    await commitNow();
    const filePath = path.join(dataDir, "server-secrets", `${tempId}.secret`);
    expect(fs.existsSync(filePath)).toBe(true);

    await deleteServer(tempId);

    expect(fs.existsSync(filePath)).toBe(false);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const { getDb, commitNow, deleteServer } = await import(
  "../database/init.ts"
);
const { getDataPaths } = await import("../utils/paths.ts");

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

describe("rconPassword end-to-end through the real database/init.ts write/read pipeline", () => {
  const serverId = `e2e-test-server-${Date.now()}`;

  afterAll(async () => {
    await deleteServer(serverId);
  });

  it("a real password survives create, an unrelated-field update, and never appears on disk", async () => {
    const db = await getDb();

    db.data.servers.push({
      id: serverId,
      name: "E2E RCON Test Server",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "correct-horse-battery-staple",
      isActive: false,
    });
    await commitNow();

    expect(readRawDbJson()).not.toContain("correct-horse-battery-staple");
    expect(readServerSecretFile(serverId)).toBe(
      "correct-horse-battery-staple",
    );
    const server = db.data.servers.find((s) => s.id === serverId);
    expect(server.rconPassword).toBe("correct-horse-battery-staple");

    server.name = "E2E RCON Test Server (renamed)";
    await commitNow();

    expect(server.rconPassword).toBe("correct-horse-battery-staple");
    expect(readServerSecretFile(serverId)).toBe(
      "correct-horse-battery-staple",
    );
    expect(readRawDbJson()).not.toContain("correct-horse-battery-staple");
    expect(readRawDbJson()).toContain("E2E RCON Test Server (renamed)");

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

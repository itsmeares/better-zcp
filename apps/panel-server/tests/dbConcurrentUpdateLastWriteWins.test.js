import { describe, expect, it, afterEach } from "vitest";
import { createServer, deleteServer, getServer, updateServer } from "../database/init.js";

describe("updateServer(): two concurrent updates to the same db.json record", () => {
  let createdServerId;

  afterEach(async () => {
    if (createdServerId != null) {
      await deleteServer(createdServerId);
      createdServerId = null;
    }
  });

  it("both survive when they touch DIFFERENT fields -- not a loss, the second call's spread includes the first call's already-applied change", async () => {
    const server = await createServer({
      name: "ConcurrentUpdateTest",
      serverName: "ConcurrentUpdateTest",
      installPath: "/tmp/concurrent-update-test",
      rconHost: "127.0.0.1",
      rconPort: 27020,
      rconPassword: "x",
    });
    createdServerId = server.id;

    await Promise.all([
      updateServer(server.id, { name: "RenamedByA" }),
      updateServer(server.id, { minMemory: 6 }),
    ]);

    const stored = await getServer(server.id);
    expect(stored.name).toBe("RenamedByA");
    expect(stored.minMemory).toBe(6);
  });

  it("is ordinary last-write-wins when both touch the SAME field -- exactly one value survives, no corruption, no exception, no hang", async () => {
    const server = await createServer({
      name: "ConcurrentUpdateTest2",
      serverName: "ConcurrentUpdateTest2",
      installPath: "/tmp/concurrent-update-test-2",
      rconHost: "127.0.0.1",
      rconPort: 27021,
      rconPassword: "x",
    });
    createdServerId = server.id;

    const [resultA, resultB] = await Promise.all([
      updateServer(server.id, { name: "WinnerA" }),
      updateServer(server.id, { name: "WinnerB" }),
    ]);

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();

    const stored = await getServer(server.id);
    expect(["WinnerA", "WinnerB"]).toContain(stored.name);

    expect([resultA.name, resultB.name]).toContain(stored.name);
  });
});

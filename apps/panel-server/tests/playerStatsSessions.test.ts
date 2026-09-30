import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
  createServer,
  getDatabaseFilePath,
  getPlayerStat,
  getPlayerStats,
  initDatabase,
  logPlayerAction,
  syncPlayerSessions,
} from "../database/init.ts";
import { runForServer } from "../utils/serverScope.ts";

describe("player session history", () => {
  it("reconciles successful RCON lists idempotently, isolates profiles, and filters old sessions on reads", async () => {
    await initDatabase();
    const first = await createServer({ name: "First", serverName: "first" });
    const second = await createServer({ name: "Second", serverName: "second" });

    await runForServer(first.id, async () => {
      await syncPlayerSessions(["Alice"]);
      await syncPlayerSessions(["Alice"]);
      expect(await getPlayerStat("Alice")).toMatchObject({
        player_name: "Alice",
        session_count: 1,
      });

      await syncPlayerSessions(["Bob"]);
      const alice = await getPlayerStat("Alice");
      expect(alice?.last_session_start).toBeNull();
      expect(alice?.sessions).toHaveLength(1);
      expect(await getPlayerStat("Bob")).toMatchObject({ session_count: 1 });

      await logPlayerAction("Alice", "death", { cause: "test" });
      expect((await getPlayerStat("Alice"))?.deaths).toBe(1);

      const fixture = new DatabaseSync(getDatabaseFilePath());
      try {
        const row = fixture
          .prepare(
            "SELECT data FROM records WHERE collection='player_stats' AND server_id=? AND id='alice'",
          )
          .get(first.id);
        const player = JSON.parse(String(row?.data));
        player.sessions.push({
          start: "2000-01-01T00:00:00.000Z",
          end: "2000-01-01T00:00:10.000Z",
          duration_seconds: 10,
        });
        fixture
          .prepare(
            "UPDATE records SET data=? WHERE collection='player_stats' AND server_id=? AND id='alice'",
          )
          .run(JSON.stringify(player), first.id);
      } finally {
        fixture.close();
      }

      expect((await getPlayerStat("Alice"))?.sessions).toHaveLength(1);
      expect(
        (await getPlayerStats()).find((entry) => entry.player_name === "Alice")
          ?.sessions,
      ).toHaveLength(1);

      const verification = new DatabaseSync(getDatabaseFilePath());
      try {
        const row = verification
          .prepare(
            "SELECT data FROM records WHERE collection='player_stats' AND server_id=? AND id='alice'",
          )
          .get(first.id);
        expect(JSON.parse(String(row?.data)).sessions).toHaveLength(1);
      } finally {
        verification.close();
      }
    });

    await runForServer(second.id, async () => {
      await syncPlayerSessions(["Alice"]);
      expect(await getPlayerStat("Alice")).toMatchObject({
        player_name: "Alice",
        session_count: 1,
        sessions: [],
      });
    });

    await runForServer(first.id, async () => {
      expect((await getPlayerStat("Alice"))?.deaths).toBe(1);
      expect(await getPlayerStat("Bob")).not.toBeNull();
    });
  });
});

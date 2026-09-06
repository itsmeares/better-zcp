import { describe, expect, it, afterEach } from "vitest";
import { createServer, deleteServer, getServer, updateServer } from "../database/init.js";

// Concurrency hunt 2026-08-29 (hunt-wave5), item still open from the original
// card: "two concurrent db.json writes. Pam proved ATOMICITY (tmp + chmod +
// rename, fault-injected mid-write leaves it byte-identical). Atomicity is
// NOT mutual exclusion. Can two concurrent settings updates lose one to
// last-write-wins?"
//
// Answer, proven here rather than just reasoned about: updateServer(id,
// updates) in database/init.js does `db.data.servers[index] = {...current,
// ...updates, id, updatedAt}` -- a synchronous read-merge-write with NO
// await anywhere inside it once getDb() is warm (getDb() only does real
// disk I/O on the very first call ever in the process's lifetime; every
// call after that returns the cached `db` with no intervening await at
// all -- confirmed by reading getDb()'s body: the entire disk-I/O block is
// gated behind `if (!db) { ... }`, and the function unconditionally
// `return db;`s after it).
//
// That means there is NO TORN READ possible: JS never yields mid-expression,
// so two "concurrent" updateServer() calls (via Promise.all) can't
// interleave their own read and write -- each one's full read-merge-write
// runs as one atomic synchronous stretch. What CAN happen, proven below:
// (1) two updates to DIFFERENT fields both survive, because each call
// spreads its own full `updates` object over whatever the other call left
// behind -- not a loss, ordinary "second writer builds on the first's
// result"; (2) two updates to the SAME field are ordinary last-write-wins,
// exactly like any REST PUT without optimistic concurrency control (ETags)
// -- whichever call's synchronous block runs second simply overwrites that
// one field, with no corruption, no exception, no torn/mixed state. This is
// expected REST semantics, not a bug -- proven here so it's a verified
// answer instead of an assumption.
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

    // Both calls report success (updateServer never refuses a concurrent
    // call -- there is no restoreInProgress-style flag here at all) --
    // this is the actual finding: nothing here EVER surfaces "your change
    // was discarded" to whichever caller lost the race.
    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();

    const stored = await getServer(server.id);
    // Exactly one of the two names survives -- not a mix, not both, not
    // neither. Which one depends on Promise.all's microtask scheduling
    // (deterministically the second-listed call here, since updateServer
    // has no await ahead of the merge once getDb() is warm -- but this test
    // asserts the PROPERTY, not a specific winner, since that ordering
    // isn't itself the finding).
    expect(["WinnerA", "WinnerB"]).toContain(stored.name);

    // Neither caller's own return value LIES about what happened -- each
    // one's resolved value reflects the record's state at the moment ITS
    // OWN synchronous write ran, which is a real, honest snapshot, not a
    // stale echo of what it THOUGHT it was writing.
    expect([resultA.name, resultB.name]).toContain(stored.name);
  });
});

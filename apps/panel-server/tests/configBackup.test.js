import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBackup, createBackupIfChanged } from "../utils/configBackup.js";

// 2026-08-27: sibling of the startupScriptBackup.test.js collision fix.
// createBackup() is the shared backup-before-overwrite safety net for
// server.ini, SandboxVars.lua, spawnpoints.lua, and spawnregions.lua edits
// (apps/panel-server/routes/serverFiles.js, apps/panel-server/routes/mods.js) -- the actual
// protection an operator relies on when hand-editing config while the
// server runs. It named each backup with a millisecond-resolution
// timestamp and nothing else; two backups of the same file detected close
// together could compute an identical filename, and the second
// fs.promises.copyFile would silently overwrite the first with no error.
// This file pins that the collision can no longer happen, and that fixing
// it didn't break the "keep only the 10 newest backups" pruning.
describe("createBackup() -- backup filename collisions", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("two backups of the same file in the same millisecond get distinct names, and neither overwrites the other", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-"));
    const iniPath = path.join(root, "servertest.ini");
    fs.writeFileSync(iniPath, "version 1", "utf8");

    const toISOString = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue("2026-08-27T00-00-00-000Z");
    try {
      const first = await createBackup(root, "servertest.ini");
      expect(first.backedUp).toBe(true);

      fs.writeFileSync(iniPath, "version 2", "utf8");
      const second = await createBackup(root, "servertest.ini");
      expect(second.backedUp).toBe(true);

      expect(second.name).not.toBe(first.name);

      const backupDir = path.join(root, "backups");
      const backups = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
      expect(backups).toHaveLength(2);

      // The FIRST version's content must still be recoverable from the
      // first backup -- if the second write had silently overwritten it,
      // this would read back "version 1" a second time (or "version 2"
      // twice), not each version once.
      const contents = backups
        .map((f) => fs.readFileSync(path.join(backupDir, f), "utf8"))
        .sort();
      expect(contents).toEqual(["version 1", "version 2"]);
    } finally {
      toISOString.mockRestore();
    }
  });

  it("a third collision in the same millisecond still gets its own distinct name", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-"));
    const iniPath = path.join(root, "servertest.ini");
    fs.writeFileSync(iniPath, "version 1", "utf8");

    const toISOString = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue("2026-08-27T00-00-00-000Z");
    try {
      await createBackup(root, "servertest.ini");
      fs.writeFileSync(iniPath, "version 2", "utf8");
      await createBackup(root, "servertest.ini");
      fs.writeFileSync(iniPath, "version 3", "utf8");
      const third = await createBackup(root, "servertest.ini");
      expect(third.backedUp).toBe(true);

      const backupDir = path.join(root, "backups");
      const backups = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
      expect(backups).toHaveLength(3);
      expect(new Set(backups).size).toBe(3);
    } finally {
      toISOString.mockRestore();
    }
  });

  it("pruning still keeps only the 10 newest when some names carry a collision suffix", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-"));
    const iniPath = path.join(root, "servertest.ini");
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(iniPath, "current", "utf8");

    // Seed 9 pre-existing backups, oldest first, one of them already
    // carrying a collision suffix -- pruning must still treat it as one
    // file among the rest, not double-count it or crash on the shape.
    for (let i = 0; i < 9; i++) {
      const ts = `2026-08-2${i}T00-00-00-000Z`;
      fs.writeFileSync(
        path.join(backupDir, `servertest.ini.${ts}.bak`),
        `seed ${i}`,
        "utf8",
      );
    }
    fs.writeFileSync(
      path.join(backupDir, "servertest.ini.2026-08-29T00-00-00-000Z-2.bak"),
      "seed collision",
      "utf8",
    );

    // 10 pre-existing + this one new backup = 11 -> pruning should drop to 10.
    const result = await createBackup(root, "servertest.ini");
    expect(result.backedUp).toBe(true);

    const remaining = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
    expect(remaining).toHaveLength(10);
    // The brand-new backup must never be the one pruned away.
    expect(remaining).toContain(result.name);
  });

  // 2026-08-27, operator directive ("make sure backups works") relayed by
  // god: the sibling collision fix in backupService.js sorts by real file
  // birthtime, but this pruner used to sort the FILENAMES as strings, then
  // slice(10). For files sharing the SAME millisecond -- exactly the case
  // the collision suffix exists to handle -- "name.<ts>-2.bak" sorts
  // LEXICOGRAPHICALLY BEFORE "name.<ts>.bak" ('-' < '.'), so within a
  // colliding group the plain (chronologically-FIRST/oldest) name was
  // always treated as "newest". That only becomes an observable bug when
  // the keep/drop boundary falls INSIDE a colliding group -- put the group
  // at the OLDEST timestamp in the set, with more members than fit in the
  // remaining "keep" slots, and the buggy sort deletes the wrong member of
  // the group instead of the group's true oldest.
  it("when a same-millisecond collision group straddles the retention boundary, prunes the group's actual oldest member -- not whichever name sorts last", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-"));
    const iniPath = path.join(root, "servertest.ini");
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(iniPath, "current", "utf8");

    function busyWaitMs(ms) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        /* force real, distinct fs birthtimes between writes */
      }
    }

    // Pruning now sorts by real fs birthtime (the fix under test), so what
    // makes a file "oldest" here is WRITE ORDER, not the fictional date
    // embedded in its name -- that embedded date only has to be internally
    // consistent enough for the old, buggy string-sort to rank this group
    // as chronologically EARLIER than the seeds by name (see the assertion
    // on the buggy behavior below), it plays no role in the real ordering.
    //
    // A 3-member same-millisecond collision group, written FIRST (truly
    // oldest overall): plain name first (truly oldest of the group), then
    // "-2" (truly second). createBackup() itself supplies the third, real
    // member later below (gets "-3") -- the actual code path under test,
    // not a hand-built fixture standing in for it.
    const collidedTs = "2026-08-01T00-00-00-000Z";
    fs.writeFileSync(
      path.join(backupDir, `servertest.ini.${collidedTs}.bak`),
      "group member 1 (truly oldest)",
      "utf8",
    );
    busyWaitMs(2);
    fs.writeFileSync(
      path.join(backupDir, `servertest.ini.${collidedTs}-2.bak`),
      "group member 2 (truly second)",
      "utf8",
    );
    busyWaitMs(2);

    // 8 seeds, written AFTER the group above -- truly newer than the whole
    // group, and never at risk in this scenario.
    for (let i = 0; i < 8; i++) {
      const ts = `2026-08-2${i}T00-00-00-000Z`;
      fs.writeFileSync(
        path.join(backupDir, `servertest.ini.${ts}.bak`),
        `seed ${i}`,
        "utf8",
      );
      busyWaitMs(2);
    }

    // 2 pre-seeded group members + 8 seeds = 10 pre-existing. This call's
    // own backup becomes an 11th, colliding into "-3" -- pushing the total
    // to 11 and forcing exactly one deletion, which must land inside the
    // collision group (its true oldest, written before anything else in
    // this test), not among the strictly-newer seeds.
    // collidedTs already contains no ':' or '.', so createBackup()'s own
    // `.replace(/[:.]/g, "-")` on this mocked value is a no-op -- it comes
    // out exactly as collidedTs, landing in the same collision group as
    // the two pre-seeded members above.
    const toISOString = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue(collidedTs);
    try {
      const result = await createBackup(root, "servertest.ini");
      expect(result.backedUp).toBe(true);
      expect(result.name).toBe(`servertest.ini.${collidedTs}-3.bak`);

      const remaining = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
      expect(remaining).toHaveLength(10);

      // All 8 seeds survive -- they were never in contention.
      for (let i = 0; i < 8; i++) {
        expect(remaining).toContain(`servertest.ini.2026-08-2${i}T00-00-00-000Z.bak`);
      }
      // The group's true oldest member is the one dropped.
      expect(remaining).not.toContain(`servertest.ini.${collidedTs}.bak`);
      // Its true middle and true newest members both survive -- this is
      // the assertion the old string-sort code got backwards: it kept the
      // plain name (treating it as "newest" of the group) and deleted
      // "-2" instead.
      expect(remaining).toContain(`servertest.ini.${collidedTs}-2.bak`);
      expect(remaining).toContain(`servertest.ini.${collidedTs}-3.bak`);
    } finally {
      toISOString.mockRestore();
    }
  });
});

// 2026-08-27, operator directive ("make sure backups works") relayed by god,
// safety-net follow-up: createBackup()/writeIniWithBackup() only ever fire
// from an explicit human edit-and-save action -- no restart, scheduled or
// manual, and no automated event of any kind ever took a config backup, so
// the panel's backup screen had nothing to offer when a config reverted
// unattended (loonE, Discord). createBackupIfChanged() is the piece that
// lets an UNATTENDED caller use the same backup machinery safely: an
// unconditional backup on every restart of a server that restarts on a
// schedule would fill the keep-10 quota with duplicate copies of unchanged
// content and evict the real, content-different human-edit backups instead
// -- the same shape as the sort-order pruner bug fixed earlier tonight,
// just reached by flooding the count instead of misordering it.
describe("createBackupIfChanged() -- backup only when content actually differs", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("no existing backup at all: backs up, same as createBackup()", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-ifchanged-"));
    const iniPath = path.join(root, "servertest.ini");
    fs.writeFileSync(iniPath, "version 1", "utf8");

    const result = await createBackupIfChanged(root, "servertest.ini");

    expect(result.backedUp).toBe(true);
    const backupDir = path.join(root, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, backups[0]), "utf8")).toBe(
      "version 1",
    );
  });

  it("live content is byte-identical to the most recent backup: skips, writes nothing new", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-ifchanged-"));
    const iniPath = path.join(root, "servertest.ini");
    fs.writeFileSync(iniPath, "unchanged content", "utf8");

    const first = await createBackupIfChanged(root, "servertest.ini");
    expect(first.backedUp).toBe(true);

    // Nothing touched the live file in between -- exactly what an
    // unattended scheduled restart looks like when the operator hasn't
    // edited config since the last one.
    const second = await createBackupIfChanged(root, "servertest.ini");
    expect(second).toEqual({ backedUp: false, reason: "unchanged" });

    const backupDir = path.join(root, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(1); // still just the one -- no duplicate
  });

  it("live content differs from the most recent backup: backs up the new version", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-ifchanged-"));
    const iniPath = path.join(root, "servertest.ini");
    fs.writeFileSync(iniPath, "version 1", "utf8");

    const first = await createBackupIfChanged(root, "servertest.ini");
    expect(first.backedUp).toBe(true);

    fs.writeFileSync(iniPath, "version 2 -- an operator actually changed this", "utf8");
    const second = await createBackupIfChanged(root, "servertest.ini");
    expect(second.backedUp).toBe(true);
    expect(second.name).not.toBe(first.name);

    const backupDir = path.join(root, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(2);
  });

  it("a real, repeated 'scheduled restart' pattern never floods the keep-10 quota with duplicates of unchanged content", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-ifchanged-"));
    const iniPath = path.join(root, "servertest.ini");
    fs.writeFileSync(iniPath, "stable config, never touched by a human", "utf8");

    // Simulate 15 scheduled restarts in a row with no human edit between
    // any of them -- the exact scenario god flagged as a treadmill risk.
    for (let i = 0; i < 15; i++) {
      await createBackupIfChanged(root, "servertest.ini");
    }

    const backupDir = path.join(root, "backups");
    const backups = fs.readdirSync(backupDir);
    // Not 15, not even close to the keep-10 ceiling -- the unchanged
    // content was recognized every time after the first.
    expect(backups).toHaveLength(1);
  });

  it("no live file at all: delegates to createBackup()'s own no-source result", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-ifchanged-"));
    // Nothing written at all -- source genuinely doesn't exist.

    const result = await createBackupIfChanged(root, "servertest.ini");

    expect(result).toEqual({ backedUp: false, reason: "no-source" });
  });
});

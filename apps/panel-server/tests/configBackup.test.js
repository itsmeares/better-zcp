import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBackup, createBackupIfChanged } from "../utils/configBackup.js";

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

    const result = await createBackup(root, "servertest.ini");
    expect(result.backedUp).toBe(true);

    const remaining = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
    expect(remaining).toHaveLength(10);
    expect(remaining).toContain(result.name);
  });

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

    for (let i = 0; i < 8; i++) {
      const ts = `2026-08-2${i}T00-00-00-000Z`;
      fs.writeFileSync(
        path.join(backupDir, `servertest.ini.${ts}.bak`),
        `seed ${i}`,
        "utf8",
      );
      busyWaitMs(2);
    }

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

      for (let i = 0; i < 8; i++) {
        expect(remaining).toContain(`servertest.ini.2026-08-2${i}T00-00-00-000Z.bak`);
      }
      expect(remaining).not.toContain(`servertest.ini.${collidedTs}.bak`);
      expect(remaining).toContain(`servertest.ini.${collidedTs}-2.bak`);
      expect(remaining).toContain(`servertest.ini.${collidedTs}-3.bak`);
    } finally {
      toISOString.mockRestore();
    }
  });
});

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

    const second = await createBackupIfChanged(root, "servertest.ini");
    expect(second).toEqual({ backedUp: false, reason: "unchanged" });

    const backupDir = path.join(root, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(1);
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

    for (let i = 0; i < 15; i++) {
      await createBackupIfChanged(root, "servertest.ini");
    }

    const backupDir = path.join(root, "backups");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(1);
  });

  it("no live file at all: delegates to createBackup()'s own no-source result", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-ifchanged-"));

    const result = await createBackupIfChanged(root, "servertest.ini");

    expect(result).toEqual({ backedUp: false, reason: "no-source" });
  });
});

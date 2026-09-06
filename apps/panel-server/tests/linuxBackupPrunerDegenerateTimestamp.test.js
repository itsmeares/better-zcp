import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBackup } from "../utils/configBackup.js";

describe("createBackup() pruning under a degenerate (all-identical) fs timestamp", () => {
  let root;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the brand-new backup even when every backup on disk reports the identical birthtime", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-degenerate-"));
    const iniPath = path.join(root, "servertest.ini");
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(iniPath, "current", "utf8");

    for (let i = 0; i < 10; i++) {
      const ts = `2026-08-2${i}T00-00-00-000Z`;
      fs.writeFileSync(
        path.join(backupDir, `servertest.ini.${ts}.bak`),
        `seed ${i}`,
        "utf8",
      );
    }

    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      const real = await realStat(p);
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        birthtimeMs: 0,
        birthtime: new Date(0),
      });
    });

    const result = await createBackup(root, "servertest.ini");
    expect(result.backedUp).toBe(true);

    const remaining = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
    expect(remaining).toHaveLength(10);

    expect(remaining).toContain(result.name);
    expect(remaining).not.toContain("servertest.ini.2026-08-20T00-00-00-000Z.bak");
    for (let i = 1; i < 10; i++) {
      expect(remaining).toContain(`servertest.ini.2026-08-2${i}T00-00-00-000Z.bak`);
    }
  });
});

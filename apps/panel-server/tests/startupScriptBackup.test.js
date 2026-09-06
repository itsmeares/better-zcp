import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { regenerateStartupScriptsWithBackup } from "../routes/server.js";

// 2026-08-26 bug hunt: POST /start regenerates StartServer_<name>.bat and
// start-server_<name>.sh from the DB record on every stopped-to-started
// transition ("so config changes take effect" -- confirmed live: it's the
// same block that makes minMemory/maxMemory/useDebug/adminPassword reach a
// running server at all). It did this UNCONDITIONALLY -- no check for
// whether the file already had different content, no backup, no warning --
// so hand-tuned JVM flags a user added directly to the script vanished
// silently the next time they pressed Start. That is the single most
// ordinary operator action there is ("the server went down, I started it
// again"), which makes this the highest-severity finding of the night:
// silent, unrecoverable destruction of user work.
//
// Both invariants have to hold at once: config changes must still always
// take effect (skipping regeneration entirely would trade silent data loss
// for silent stale config, the exact inverse defect), AND the user must not
// lose work without a visible trace of what happened. This file pins both.
describe("regenerateStartupScriptsWithBackup()", () => {
  let tmpRoot;

  function makeFiles(overrides = {}) {
    const batPath = path.join(tmpRoot, "StartServer_Test.bat");
    const shPath = path.join(tmpRoot, "start-server_Test.sh");
    return [
      { path: batPath, content: overrides.bat ?? "@echo off\r\nREM v1\r\n" },
      { path: shPath, content: overrides.sh ?? "#!/bin/bash\n# v1\n" },
    ];
  }

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("first-ever generation: no prior file, writes through, no backup", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    const files = makeFiles();

    const backups = regenerateStartupScriptsWithBackup(tmpRoot, files);

    expect(backups).toEqual([]);
    expect(fs.readFileSync(files[0].path, "utf8")).toBe(files[0].content);
    expect(fs.readFileSync(files[1].path, "utf8")).toBe(files[1].content);
    // No stray .bak files from a first-ever write.
    const entries = fs.readdirSync(tmpRoot);
    expect(entries.some((e) => e.includes(".bak-"))).toBe(false);
  });

  it("regenerating byte-identical content twice produces no backup (repeated Start with no config change)", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    const files = makeFiles();

    regenerateStartupScriptsWithBackup(tmpRoot, files);
    const secondRun = regenerateStartupScriptsWithBackup(tmpRoot, files);

    expect(secondRun).toEqual([]);
  });

  it("a genuine config change (different generated content) between two panel-only writes does NOT trigger a backup -- invariant 1: config changes must still take effect silently", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    const filesV1 = makeFiles();
    regenerateStartupScriptsWithBackup(tmpRoot, filesV1);

    // Simulate the admin changing memory allocation in the UI: the panel
    // itself generates different content on the next Start.
    const filesV2 = makeFiles({
      bat: "@echo off\r\nREM v2 -- more memory\r\n",
      sh: "#!/bin/bash\n# v2 -- more memory\n",
    });
    const backups = regenerateStartupScriptsWithBackup(tmpRoot, filesV2);

    expect(backups).toEqual([]);
    expect(fs.readFileSync(filesV2[0].path, "utf8")).toBe(filesV2[0].content);
    expect(fs.readFileSync(filesV2[1].path, "utf8")).toBe(filesV2[1].content);
  });

  it("a hand-edit between two Starts is detected, backed up with the user's content preserved, and still regenerated -- invariant 2: no silent loss", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    const filesV1 = makeFiles();
    regenerateStartupScriptsWithBackup(tmpRoot, filesV1);

    // User hand-edits the live .bat directly (extra JVM flag), bypassing the panel.
    const handEdited = "@echo off\r\nREM v1\r\nREM -Xss4m added by hand\r\n";
    fs.writeFileSync(filesV1[0].path, handEdited, "utf8");

    const filesV2 = makeFiles({ bat: "@echo off\r\nREM v2\r\n" });
    const backups = regenerateStartupScriptsWithBackup(tmpRoot, filesV2);

    expect(backups.length).toBe(1);
    expect(backups[0]).toContain("StartServer_Test.bat");

    // The regenerated file has the new content -- config change still took effect.
    expect(fs.readFileSync(filesV2[0].path, "utf8")).toBe(filesV2[0].content);

    // The hand-edited content survives, untouched, in a backup file.
    const entries = fs.readdirSync(tmpRoot);
    const backupFile = entries.find((e) => e.startsWith("StartServer_Test.bat.bak-"));
    expect(backupFile).toBeTruthy();
    expect(fs.readFileSync(path.join(tmpRoot, backupFile), "utf8")).toBe(handEdited);
  });

  it("upgrade population -- a pre-existing file with NO fingerprint sidecar at all is treated as unknown provenance, not as safe-to-clobber", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    const files = makeFiles();
    // Simulate a pre-fix install: the script already exists (written by an
    // older panel version, or hand-edited), but no sidecar was ever created.
    fs.writeFileSync(files[0].path, "@echo off\r\nREM pre-fingerprint install\r\n", "utf8");

    const backups = regenerateStartupScriptsWithBackup(tmpRoot, files);

    expect(backups.length).toBe(1);
    expect(backups[0]).toContain("StartServer_Test.bat");
    // Second run, now that a fingerprint exists and matches -- no more backups.
    const secondRun = regenerateStartupScriptsWithBackup(tmpRoot, files);
    expect(secondRun).toEqual([]);
  });

  it("backups are never pruned -- repeated hand-edits accumulate one .bak per detected change, deliberately", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    const filesV1 = makeFiles();
    regenerateStartupScriptsWithBackup(tmpRoot, filesV1);

    fs.writeFileSync(filesV1[0].path, "hand-edit 1", "utf8");
    regenerateStartupScriptsWithBackup(tmpRoot, makeFiles({ bat: "v2" }));

    fs.writeFileSync(filesV1[0].path, "hand-edit 2", "utf8");
    regenerateStartupScriptsWithBackup(tmpRoot, makeFiles({ bat: "v3" }));

    const backupCount = fs
      .readdirSync(tmpRoot)
      .filter((e) => e.startsWith("StartServer_Test.bat.bak-")).length;
    expect(backupCount).toBe(2);
  });

  it("a corrupt fingerprint sidecar doesn't crash regeneration -- falls back to treating every existing file as unknown provenance", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    fs.writeFileSync(path.join(tmpRoot, ".pz-panel-scripts.json"), "{not valid json", "utf8");
    const files = makeFiles();
    fs.writeFileSync(files[0].path, "pre-existing content", "utf8");

    expect(() => regenerateStartupScriptsWithBackup(tmpRoot, files)).not.toThrow();
    const backups = regenerateStartupScriptsWithBackup(tmpRoot, makeFiles({ bat: "next" }));
    // Sidecar is now valid JSON again after the first successful run above.
    expect(backups).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { waitForArchiveEntry, appendDirectoryToArchive } from "../services/backupService.ts";


function makeFakeArchive(outcomeFor) {
  const archive = new EventEmitter();
  archive.file = (fullPath, opts) => {
    const outcome = outcomeFor(fullPath);
    queueMicrotask(() => {
      if (outcome === "entry") {
        archive.emit("entry", { name: opts.name });
      } else if (outcome === "enoent") {
        archive.emit(
          "warning",
          Object.assign(new Error(`ENOENT: no such file or directory, stat '${fullPath}'`), {
            code: "ENOENT",
          }),
        );
      } else if (outcome === "other-warning") {
        archive.emit("warning", Object.assign(new Error("permission denied"), { code: "EACCES" }));
      } else if (outcome === "error") {
        archive.emit("error", new Error("archive stream broke"));
      }
    });
  };
  return archive;
}

describe("waitForArchiveEntry(): distinguishes a genuine success from a vanished-file skip", () => {
  it("resolves {skipped:false} on a real archive entry", async () => {
    const archive = makeFakeArchive(() => "entry");
    const result = await waitForArchiveEntry(archive, () => archive.file("/x", { name: "x" }));
    expect(result).toEqual({ skipped: false });
  });

  it("resolves {skipped:true} on an ENOENT warning -- a vanished file is not a real failure", async () => {
    const archive = makeFakeArchive(() => "enoent");
    const result = await waitForArchiveEntry(archive, () => archive.file("/x", { name: "x" }));
    expect(result).toEqual({ skipped: true });
  });

  it("rejects on a non-ENOENT warning -- only a vanished file is tolerated", async () => {
    const archive = makeFakeArchive(() => "other-warning");
    await expect(
      waitForArchiveEntry(archive, () => archive.file("/x", { name: "x" })),
    ).rejects.toThrow("permission denied");
  });

  it("rejects on a real archive error", async () => {
    const archive = makeFakeArchive(() => "error");
    await expect(
      waitForArchiveEntry(archive, () => archive.file("/x", { name: "x" })),
    ).rejects.toThrow("archive stream broke");
  });
});

describe("appendDirectoryToArchive(): precise skip tracking over a real directory walk", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-skip-"));
    fs.writeFileSync(path.join(tempDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tempDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tempDir, "c.txt"), "c");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the archive-relative path of exactly the file that vanished, none of the others", async () => {
    const archive = makeFakeArchive((fullPath) =>
      fullPath.endsWith("b.txt") ? "enoent" : "entry",
    );
    const skipped = await appendDirectoryToArchive(archive, tempDir, "MyBackup");
    expect(skipped).toEqual(["MyBackup/b.txt"]);
  });

  it("returns an empty array when nothing was skipped -- a clean backup must not report a phantom skip", async () => {
    const archive = makeFakeArchive(() => "entry");
    const skipped = await appendDirectoryToArchive(archive, tempDir, "MyBackup");
    expect(skipped).toEqual([]);
  });

  it("returns every vanished file when more than one is skipped", async () => {
    const archive = makeFakeArchive((fullPath) =>
      fullPath.endsWith("a.txt") || fullPath.endsWith("c.txt") ? "enoent" : "entry",
    );
    const skipped = await appendDirectoryToArchive(archive, tempDir, "MyBackup");
    expect(skipped.sort()).toEqual(["MyBackup/a.txt", "MyBackup/c.txt"]);
  });
});

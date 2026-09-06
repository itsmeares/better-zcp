import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { crc32 } from "zlib";
import unzipper, { Open } from "unzipper";
import { StreamingZipWriter } from "../utils/streamingZip.js";

// Extracts a zip via unzip.Parse() -- the streaming, LOCAL-header reader
// backupService.restoreBackup() actually pipes a backup through, as opposed
// to unzip.Open.file() (the central-directory reader used only for
// read-only inspection: _verifyExtractedIntegrity(), getBackupSnapshot()).
// The two APIs read genuinely different bytes of the same file and can
// disagree about whether an archive is readable at all -- see the fix
// history below. Any new coverage of this writer's real-world readability
// belongs on this path, not just Open.file().
async function extractViaParse(zipPath, destDir) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    let pendingWrites = 0;
    let parseClosed = false;
    const settleIfComplete = () => {
      if (parseClosed && pendingWrites === 0) settle();
    };
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on("entry", (entry) => {
        const entryPath = path.join(destDir, entry.path);
        if (entry.type === "Directory") {
          fs.mkdirSync(entryPath, { recursive: true });
          entry.autodrain();
          return;
        }
        fs.mkdirSync(path.dirname(entryPath), { recursive: true });
        const ws = fs.createWriteStream(entryPath);
        pendingWrites++;
        ws.on("error", (err) => {
          pendingWrites--;
          settle(err);
        });
        ws.on("close", () => {
          pendingWrites--;
          settleIfComplete();
        });
        entry.on("error", settle);
        entry.pipe(ws);
      })
      .on("close", () => {
        parseClosed = true;
        settleIfComplete();
      })
      .on("error", settle);
  });
}

describe("StreamingZipWriter", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it(
    "writes a high entry count without retaining an entry array",
    async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-streaming-zip-"));
      const zipPath = path.join(tempDir, "many-files.zip");
      const writer = new StreamingZipWriter(zipPath, { level: 0 });
      // Was 12_000 (2026-08-29 flake hunt): the property this proves --
      // Object.keys(writer)).not.toContain("entries") below -- is a
      // STRUCTURAL assertion about the instance shape, exactly as true at 100
      // as at 12,000; the count was never load-bearing for it, and it doesn't
      // cross a real format boundary either -- the archive-level zip64 END
      // record (needed once entry count exceeds 65,535) is emitted
      // unconditionally regardless of count, so no entry count exercises
      // different code there. (Per-entry format IS conditional as of the
      // 2026-08-30 interop fix below, but on each entry's SIZE, not on how
      // many entries came before it -- irrelevant to this test's own claim.)
      // It WAS load-bearing for wall-clock cost: this is the
      // only test in the 316-file suite whose loop does a real awaited I/O
      // round trip per iteration (traced addBuffer -> addStream -> a real
      // fs.WriteStream write plus a real zlib deflate, each one a scheduler
      // preemption point), which made it the suite's slowest test and, under
      // real full-run CPU contention on this floor's shared machines, an
      // intermittent timeout. Reduced to a third of the original count,
      // scaled from a measured ~54s worst-case wall time for 12,000 under
      // real full-suite contention, to bring the worst case back under this
      // project's own existing 3x-margin-to-timeout convention (see
      // vitest.config.js's testTimeout comment, written for the same
      // CPU-contention class of problem).
      const entryCount = 4_000;

      for (let index = 0; index < entryCount; index += 1) {
        await writer.addBuffer(Buffer.from(`file-${index}`), `save/${index}.txt`);
      }

      const result = await writer.finalize();
      const archive = await Open.file(zipPath);

      expect(result.entries).toBe(entryCount);
      expect(result.size).toBeGreaterThan(0);
      expect(Object.keys(writer)).not.toContain("entries");
      expect(archive.files).toHaveLength(entryCount);
      expect(archive.files[0].path).toBe("save/0.txt");
      expect(archive.files.at(-1).path).toBe(`save/${entryCount - 1}.txt`);
    },
    // 2026-09-04: reducing entryCount alone (above) wasn't enough margin --
    // this test still hit the global 60000ms testTimeout on a real full
    // server-suite run (Jim), a genuine flake, not a defect in the writer.
    // This is a timeout-MARGIN problem, not an assertion-direction one (see
    // linuxDiscordGatewayResilience.test.js's fix the same day for that
    // other class) -- the fix here is more slack for this one slow,
    // real-I/O-bound test, not a different measurement, following the same
    // per-test-override pattern supervisor-restart.test.js already uses for
    // its own slow real-subprocess tests.
    //
    // Re-measured rather than re-guessed: 48 runs of just this test under
    // sustained synthetic load (48 CPU-burn processes oversubscribing a
    // 16-core box 3x, plus 16 copies of this exact test running
    // concurrently -- deliberately harsher I/O contention than a natural
    // full-suite run, which is the more realistic worst case for a test
    // whose bottleneck IS concurrent disk I/O) measured a worst case of
    // 17930ms -- closely matching the entryCount reduction's own
    // extrapolation (the original 12,000-entry measurement was ~54000ms;
    // 54000/3 = 18000ms), so the entryCount cut's math held up under
    // independent re-measurement. It still wasn't enough today, which means
    // real floor contention right now exceeds what a single sandboxed
    // reproduction captures -- same honest gap as the Discord fix's
    // unreproduced flake. Rather than re-deriving a smaller number from
    // that gap, this timeout is 3x the ORIGINAL real full-suite
    // measurement (54000ms) directly: 160000ms, comfortably above both the
    // current 60000ms global default that already proved insufficient once
    // and this task's own fresh 17930ms reproduction.
    160000,
  );

  // hunt-2026-08-30 (wire-streamingzipwriter-into-backupservice-write-path):
  // this pins down a real interop bug that was found, and now the fix, for
  // a previously-undiscovered reason backupService.js still uses archiver
  // instead of this writer. Every PRIOR check of this migration
  // (streamingZip.test.js's own coverage above, and the hive-floor audit
  // that first proved this an unfinished migration) only ever exercised
  // unzipper's Open.file() -- the CENTRAL-DIRECTORY reader, used by
  // _verifyExtractedIntegrity() and getBackupSnapshot(). That path worked
  // fine against this writer's output even before the fix below, because
  // the central directory always carried real, final crc32/size values.
  //
  // backupService.restoreBackup()'s actual extraction goes through a
  // DIFFERENT unzipper API -- unzip.Parse(), a streaming LOCAL-header
  // reader -- and until this fix, that path could not read this writer's
  // output AT ALL, for every single file entry, not just an edge case. Two
  // independent local-header/data-descriptor bugs, both now fixed here:
  //
  //   1. localFileHeader() used to write 0xFFFFFFFF zip64-escape
  //      placeholders into the local header's compressed/uncompressed size
  //      fields for EVERY entry, regardless of real size. Per PKZIP
  //      APPNOTE 4.3.9.1, when DATA_DESCRIPTOR_FLAG (bit 3) is set those
  //      fields "MUST be set to zero" -- 0xFFFFFFFF is a DIFFERENT signal
  //      ("the real value is in the zip64 extra field"), and the two
  //      conflict. unzipper's parse.js computes `fileSizeKnown =
  //      !(flags&0x08) || compressedSize>0` -- reading the placeholder as
  //      a real ~4GiB size and streaming that many bytes as entry data
  //      instead of watching for the descriptor, reading straight through
  //      the rest of the archive before desyncing. Fixed: write 0 (both
  //      fields already were 0, before this bug's own fix pass revealed
  //      they had never been), the spec-correct value.
  //   2. Even with (1) fixed alone (confirmed by testing it in isolation
  //      during this investigation -- it still failed identically), a
  //      SECOND, independent bug remained: dataDescriptor() unconditionally
  //      wrote the 24-byte ZIP64 form (4-byte signature + 4-byte crc32 +
  //      TWO 8-byte size fields). unzipper's own
  //      Parse.prototype._processDataDescriptor reads a hardcoded 16 bytes
  //      (signature + crc32 + TWO 4-byte size fields) -- it has no zip64
  //      variant at all, in this project's pinned unzipper version. Every
  //      entry's descriptor left 8 stray bytes unconsumed, desyncing
  //      whatever came next regardless of the local header being correct.
  //      Fixed: dataDescriptor() now writes the classic 16-byte form for
  //      any entry whose real compressedSize and size both fit under
  //      0xFFFFFFFE (i.e. virtually every real file), and only falls back
  //      to the 24-byte zip64 form for an entry that genuinely needs it.
  //
  // RESIDUAL, KNOWN, NOT FIXED HERE: an entry that legitimately needs the
  // 24-byte zip64 descriptor (single file >= ~4GiB) is STILL unreadable by
  // this project's unzip.Parse() -- that's an inherent limitation of the
  // pinned unzipper version (it never learned to read that variant at all,
  // for any writer, not just this one), not something fixable from this
  // file alone. No test below exercises that size, and no claim is made
  // that this writer is zip64-safe end-to-end; only that ordinary,
  // realistic file sizes now round-trip correctly through both unzipper
  // APIs backupService actually depends on.
  it("round-trips real content through unzipper's streaming Parse() -- the API backupService.restoreBackup() actually uses", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-streaming-zip-parse-"));
    const zipPath = path.join(tempDir, "mixed.zip");
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(path.join(srcDir, "world", "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "world", "compressible.txt"),
      "hello world ".repeat(20000),
    );
    fs.writeFileSync(path.join(srcDir, "world", "empty.bin"), "");
    const randomBuf = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < randomBuf.length; i += 1) {
      randomBuf[i] = Math.floor(Math.random() * 256);
    }
    fs.writeFileSync(path.join(srcDir, "world", "random.bin"), randomBuf);
    fs.writeFileSync(
      path.join(srcDir, "world", "nested", "leaf.txt"),
      "leaf content\n".repeat(500),
    );

    const writer = new StreamingZipWriter(zipPath, { level: 6 });
    await writer.addDirectory("world/nested/");
    await writer.addFile(path.join(srcDir, "world", "compressible.txt"), "world/compressible.txt");
    await writer.addFile(path.join(srcDir, "world", "empty.bin"), "world/empty.bin");
    await writer.addFile(path.join(srcDir, "world", "random.bin"), "world/random.bin");
    await writer.addFile(path.join(srcDir, "world", "nested", "leaf.txt"), "world/nested/leaf.txt");
    await writer.addBuffer(Buffer.from(JSON.stringify({ ok: true })), "panel-server-snapshot.json");
    await writer.finalize();

    // Path A: the central-directory reader (what always worked).
    const archive = await Open.file(zipPath);
    const byPath = Object.fromEntries(archive.files.map((f) => [f.path, f]));

    // Path B: the streaming local-header reader restoreBackup() actually
    // uses -- this is the one that used to throw before the fix above.
    const stagingPath = path.join(tempDir, "staging");
    fs.mkdirSync(stagingPath, { recursive: true });
    await extractViaParse(zipPath, stagingPath);

    expect(
      fs.existsSync(path.join(stagingPath, "world", "nested")) &&
        fs.statSync(path.join(stagingPath, "world", "nested")).isDirectory(),
    ).toBe(true);

    const files = [
      ["world/compressible.txt", path.join(srcDir, "world", "compressible.txt")],
      ["world/empty.bin", path.join(srcDir, "world", "empty.bin")],
      ["world/random.bin", path.join(srcDir, "world", "random.bin")],
      ["world/nested/leaf.txt", path.join(srcDir, "world", "nested", "leaf.txt")],
      ["panel-server-snapshot.json", null],
    ];

    for (const [zipRelPath, origPath] of files) {
      const extracted = fs.readFileSync(path.join(stagingPath, zipRelPath));

      // Exactly what _verifyExtractedIntegrity() checks on every real
      // restore: the extracted bytes' own crc32 against the central
      // directory's recorded value.
      expect(crc32(extracted, 0)).toBe(byPath[zipRelPath].crc32);

      // And, where we have a source file to compare against, that the
      // extracted content is byte-identical to what was written in --
      // the crc32 match alone can't rule out both sides being wrong the
      // same way.
      if (origPath) {
        expect(extracted.equals(fs.readFileSync(origPath))).toBe(true);
      }
    }
  });
});
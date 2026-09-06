import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

// 2026-08-29 hunt (god): backup-and-restore, suspect 6 (restore pre-flight)
// -- "restoring from a corrupt backup over a working world is the only way
// this subsystem can make things worse than doing nothing."
//
// Empirically confirmed (scratch probe against the real `unzipper` package
// used here, both stored and compressed entries) that its streaming
// Parse() -- the API restoreBackup() extracts with -- reads each entry's
// recorded CRC32 as bookkeeping and NEVER recomputes it against the bytes
// it actually writes to disk. A single flipped byte anywhere in a
// compressed entry's data silently produced content of a DIFFERENT LENGTH
// than the original, with zero error raised anywhere in the pipeline --
// not a rare, hand-crafted case, a random single-byte flip reproduced it
// on the first try. Bit rot on backup storage, a bad copy, or a truncated
// download all look identical to a healthy backup right up until a restore
// silently swaps corrupted bytes in over a working world.
//
// This pins the fix: _verifyExtractedIntegrity() recomputes every extracted
// file's CRC32 against what the archive's own central directory (read via
// unzip.Open.file(), independent of the streaming Parse() used to extract)
// recorded for that entry, BEFORE the swap. A mismatch refuses the restore
// and leaves the live save untouched -- staging is still disposable at that
// point, so refusing costs nothing.
//
// hunt-wave11 follow-up (god's gate, 2026-08-29): the ORIGINAL single test
// here corrupted one random byte and asserted the resulting message matched
// /integrity verification/i. That's LOAD-DEPENDENT, not flaky-by-chance --
// which region of the compressed stream a random byte lands in determines
// WHICH mechanism catches it. A byte inside DEFLATE's structural metadata
// (block headers, Huffman tables) breaks decompression itself, and
// unzipper's Parse() surfaces that as its own stream error (observed on
// god's gate: "expected 'unexpected end of file' to match
// /integrity verification/i") BEFORE _verifyExtractedIntegrity ever runs.
// A byte inside stable literal/length-code data instead just changes
// decoded VALUES with the stream still parsing cleanly, which is what
// actually reaches the CRC check this fix exists to prove.
//
// The safety PROPERTY held in both cases -- refused, live save untouched --
// so asserting a specific message on a random corruption was testing the
// mechanism, not the property, and would flake in the safe direction
// (intermittently failing on a CORRECT outcome, which trains everyone to
// ignore the failure). Split into two tests that cannot substitute for
// each other: forceCrcOnlyCorruption() below deterministically produces a
// corruption that decodes cleanly so ONLY the CRC path can catch it (naming
// that mechanism specifically in its assertions), and the random-byte-flip
// test now asserts only the property every real-world corruption must
// satisfy regardless of which mechanism catches it.

const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.js");

const SERVER_NAME = "servertest";
let root;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  return service;
}

// Flips one byte somewhere in the back half of the file -- past the local
// file headers for a small fixture, inside a compressed data region --
// simulating real-world bit rot on backup storage rather than a
// hand-crafted attack on the format. Which specific mechanism catches this
// (extraction-time stream error vs. post-extraction CRC mismatch) is
// deliberately NOT controlled here -- see forceCrcOnlyCorruption() below
// for the version that pins the mechanism.
function corruptOneByte(filePath) {
  const buf = fs.readFileSync(filePath);
  const at = Math.floor(buf.length * 0.6);
  buf[at] = buf[at] ^ 0xff;
  fs.writeFileSync(filePath, buf);
}

// Deterministically corrupts `entryName`'s compressed bytes inside the real
// zip such that (a) the DEFLATE stream still decompresses without error --
// so unzipper's streaming Parse() extracts it successfully, same as a
// healthy entry -- but (b) the decompressed content differs from the
// original, so the extracted file's recomputed CRC32 no longer matches
// what the archive's central directory recorded for that entry. This is
// the ONLY corruption shape that can reach _verifyExtractedIntegrity()
// rather than being caught earlier by extraction itself, so a restore
// refusing THIS specific corruption proves the CRC-recompute path fires,
// not just "some check, somewhere, sometimes."
//
// Locates the entry's raw compressed bytes by reading the archive's own
// central directory via `unzipper` (the same library backupService.js
// uses for exactly this purpose in _verifyExtractedIntegrity) for the
// authoritative compressedSize + crc32 + local-header offset, then walking
// the local file header's own name/extra-field lengths (NOT the central
// directory's, which need not match under a streaming writer) to find
// where the compressed payload actually starts. Searches every byte offset
// in that payload for one whose flip still round-trips through
// zlib.inflateRawSync() (proving Node's own DEFLATE implementation -- the
// same one unzipper is built on -- accepts it) while producing different
// bytes than the original. Deterministic for a fixed input (archiver's
// output for the same content and settings does not vary run to run);
// verified stable across repeated runs before landing this.
async function forceCrcOnlyCorruption(zipPath, entryName) {
  const unzipper = await import("unzipper");
  const archive = await unzipper.Open.file(zipPath);
  const entry = archive.files.find((f) => f.path.endsWith(entryName));
  if (!entry) {
    throw new Error(`forceCrcOnlyCorruption: no entry named ${entryName} in ${zipPath}`);
  }

  const buf = fs.readFileSync(zipPath);
  const localOffset = entry.offsetToLocalFileHeader;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  const original = zlib.inflateRawSync(compressed);

  let foundOffset = null;
  for (let i = 0; i < compressed.length; i++) {
    const candidate = Buffer.from(compressed);
    candidate[i] ^= 0xff;
    try {
      const out = zlib.inflateRawSync(candidate);
      if (!out.equals(original)) {
        foundOffset = i;
        break;
      }
    } catch {
      // This byte position broke the DEFLATE stream structurally -- that's
      // exactly the OTHER corruption shape (extraction-time failure), not
      // the one this helper needs. Try the next byte.
    }
  }
  if (foundOffset === null) {
    throw new Error(
      `forceCrcOnlyCorruption: could not find a byte in ${entryName}'s ${compressed.length}-byte compressed payload whose flip decodes cleanly but differs -- fixture may be too small/uncompressible for this technique.`,
    );
  }

  buf[dataStart + foundOffset] ^= 0xff;
  fs.writeFileSync(zipPath, buf);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-integrity-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  // Big enough and repetitive enough that archiver's default compression
  // actually compresses it (matches real save data, which is not random
  // noise), so corrupting it exercises the DEFLATE path, not a stored one.
  // The repetition also matters for forceCrcOnlyCorruption(): a longer
  // compressed payload gives the byte-offset search more candidates to
  // find a decode-cleanly-but-differs position in.
  fs.writeFileSync(
    path.join(savesPath, "map_meta.bin"),
    Buffer.from("LIVE ORIGINAL MAP DATA ".repeat(400)),
  );
  fs.writeFileSync(path.join(savesPath, "worldstats.txt"), "LIVE ORIGINAL STATS");
  logServerEvent.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreBackup() verifies extracted file integrity before swapping in the live save", () => {
  it("refuses via the CRC-recompute path specifically, when corruption decodes cleanly but produces wrong content", async () => {
    const service = createService();

    const createResult = await service.createBackup({ createPreRestoreBackup: false });
    expect(createResult.success).toBe(true);
    const zipPath = path.join(backupsPath, createResult.backup.name);

    await forceCrcOnlyCorruption(zipPath, "map_meta.bin");

    const beforeRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));

    const restoreResult = await service.restoreBackup(createResult.backup.name, {
      createPreRestoreBackup: false,
    });

    // Names the mechanism, not just the outcome: this corruption was built
    // specifically so extraction succeeds (a stream-error message here
    // would mean the corruption technique itself is broken, not that the
    // fix regressed) and only the CRC recompute can catch it.
    expect(restoreResult.success).toBe(false);
    expect(restoreResult.message).toMatch(/integrity verification/i);
    expect(restoreResult.message).toContain("map_meta.bin");
    expect(restoreResult.message).not.toMatch(/unexpected end of file/i);

    // The live save must be completely untouched -- not partially swapped,
    // not deleted, not replaced with the corrupt version.
    expect(fs.existsSync(savesPath)).toBe(true);
    const afterRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));
    expect(Buffer.compare(afterRestore, beforeRestore)).toBe(0);
  });

  it("refuses ANY single-byte corruption and leaves the live save untouched, regardless of which mechanism catches it", async () => {
    const service = createService();

    const createResult = await service.createBackup({ createPreRestoreBackup: false });
    expect(createResult.success).toBe(true);
    const zipPath = path.join(backupsPath, createResult.backup.name);

    corruptOneByte(zipPath);

    const beforeRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));

    const restoreResult = await service.restoreBackup(createResult.backup.name, {
      createPreRestoreBackup: false,
    });

    // Deliberately does NOT assert on restoreResult.message's content --
    // a random byte can land in DEFLATE's structural metadata (caught by
    // unzipper's own extraction-time stream error) or in stable literal
    // data (caught by _verifyExtractedIntegrity's CRC recompute), and
    // BOTH are correct: the property this test exists to prove is that
    // corruption is refused and the live save survives, not which of the
    // two independent mechanisms happened to notice it first. See the
    // test above for a corruption that pins the CRC path specifically.
    expect(restoreResult.success).toBe(false);

    expect(fs.existsSync(savesPath)).toBe(true);
    const afterRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));
    expect(Buffer.compare(afterRestore, beforeRestore)).toBe(0);
  });

  it("restores normally when every file's checksum matches (no false positives)", async () => {
    const service = createService();

    const createResult = await service.createBackup({ createPreRestoreBackup: false });
    expect(createResult.success).toBe(true);

    // Simulate real data loss so the restored content can only have come
    // from the (uncorrupted) archive.
    fs.rmSync(savesPath, { recursive: true, force: true });

    const restoreResult = await service.restoreBackup(createResult.backup.name, {
      createPreRestoreBackup: false,
    });

    expect(restoreResult.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin")).toString()).toBe(
      "LIVE ORIGINAL MAP DATA ".repeat(400),
    );
  });
});

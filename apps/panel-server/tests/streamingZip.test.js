import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { crc32 } from "zlib";
import unzipper, { Open } from "unzipper";
import { StreamingZipWriter } from "../utils/streamingZip.js";

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
    160000,
  );

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

    const archive = await Open.file(zipPath);
    const byPath = Object.fromEntries(archive.files.map((f) => [f.path, f]));

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

      expect(crc32(extracted, 0)).toBe(byPath[zipRelPath].crc32);

      if (origPath) {
        expect(extracted.equals(fs.readFileSync(origPath))).toBe(true);
      }
    }
  });
});
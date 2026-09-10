import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  streamUploadToFile,
  UPLOAD_BAD_SIGNATURE_CODE,
  UPLOAD_TOO_LARGE_CODE,
} from "../utils/uploadStream.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function outputPath(): string {
  root = mkdtempSync(join(tmpdir(), "better-zcp-upload-"));
  return join(root, "backup.zip.tmp");
}

describe("streamUploadToFile", () => {
  it("writes split zip chunks byte-for-byte without buffering the body", async () => {
    const target = outputPath();
    const body = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(40_000)]);
    const chunks = [body.subarray(0, 1), body.subarray(1, 3), body.subarray(3)];

    await expect(
      streamUploadToFile(Readable.from(chunks), target, body.length),
    ).resolves.toBe(body.length);
    expect(readFileSync(target).equals(body)).toBe(true);
  });

  it("rejects a bad signature and removes the partial temp file", async () => {
    const target = outputPath();

    await expect(
      streamUploadToFile(
        Readable.from([Buffer.from("not"), Buffer.from(" a zip")]),
        target,
        1024,
      ),
    ).rejects.toMatchObject({ code: UPLOAD_BAD_SIGNATURE_CODE });
    expect(existsSync(target)).toBe(false);
  });

  it("rejects an upload once it exceeds the configured limit", async () => {
    const target = outputPath();

    await expect(
      streamUploadToFile(
        Readable.from([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          randomBytes(10_000),
        ]),
        target,
        1024,
      ),
    ).rejects.toMatchObject({ code: UPLOAD_TOO_LARGE_CODE });
    expect(existsSync(target)).toBe(false);
  });

  it("returns zero for an empty body so the route can report no file", async () => {
    const target = outputPath();

    await expect(
      streamUploadToFile(Readable.from([]), target, 1024),
    ).resolves.toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("absorbs a request error emitted after the stream promise settled", async () => {
    const target = outputPath();
    const input = Readable.from([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    ]);

    await streamUploadToFile(input, target, 1024);
    expect(() => input.emit("error", new Error("late request error"))).not.toThrow();
  });
});

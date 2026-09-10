import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";

export const UPLOAD_TOO_LARGE_CODE = "UPLOAD_TOO_LARGE";
export const UPLOAD_BAD_SIGNATURE_CODE = "UPLOAD_BAD_SIGNATURE";

function uploadError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export async function streamUploadToFile(
  input: Readable,
  targetPath: string,
  maxBytes: number,
): Promise<number> {
  let totalBytes = 0;
  let signatureBytes = 0;
  const signature = Buffer.alloc(4);
  let outputOpened = false;
  let completed = false;

  const validate = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;

      if (totalBytes > maxBytes) {
        callback(
          uploadError(
            UPLOAD_TOO_LARGE_CODE,
            "Upload exceeds the configured size limit.",
          ),
        );
        return;
      }

      if (signatureBytes < signature.length) {
        const prefix = bytes.subarray(0, signature.length - signatureBytes);
        prefix.copy(signature, signatureBytes);
        signatureBytes += prefix.length;
      }

      callback(null, bytes);
    },
    flush(callback) {
      if (
        totalBytes > 0 &&
        (signatureBytes < signature.length || signature[0] !== 0x50 || signature[1] !== 0x4b)
      ) {
        callback(
          uploadError(
            UPLOAD_BAD_SIGNATURE_CODE,
            "File does not look like a valid .zip archive.",
          ),
        );
        return;
      }
      callback();
    },
  });
  const output = createWriteStream(targetPath, { flags: "wx" });
  output.once("open", () => {
    outputOpened = true;
  });

  try {
    await pipeline(input, validate, output);
    completed = true;
    return totalBytes;
  } finally {
    // pipeline() settles before a stream is necessarily finished emitting
    // every deferred error. Keep terminal listeners attached so a late
    // filesystem/request error cannot become an uncaught EventEmitter error.
    input.on("error", () => undefined);
    output.on("error", () => undefined);
    if (!completed && outputOpened) {
      await rm(targetPath, { force: true }).catch(() => undefined);
    }
  }
}

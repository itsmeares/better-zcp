import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { streamUploadToFileMock } = vi.hoisted(() => ({
  streamUploadToFileMock: vi.fn(),
}));

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: vi.fn(async () => null),
}));
vi.mock("../utils/uploadStream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/uploadStream.ts")>()),
  streamUploadToFile: streamUploadToFileMock,
}));

const { getActiveServer } = await import("../database/init.ts");
const { default: router } = await import("../routes/backup.ts");
const uploadStream = await vi.importActual<typeof import("../utils/uploadStream.ts")>(
  "../utils/uploadStream.ts",
);
streamUploadToFileMock.mockImplementation(uploadStream.streamUploadToFile);

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.clearAllMocks();
  streamUploadToFileMock.mockImplementation(uploadStream.streamUploadToFile);
});

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function uploadHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === "/upload");
  if (!layer) throw new Error("POST /upload route not found");
  return layer.route.stack.at(-1)!.handle;
}

function request(chunks: Buffer[], filename = "world.zip") {
  const req = Readable.from(chunks) as Readable & {
    app: { get: (key: string) => unknown };
    headers: Record<string, string>;
  };
  req.headers = {
    "content-type": "application/zip",
    "x-backup-filename": filename,
  };
  return req;
}

function app(backupsPath: string) {
  return {
    get: (key: string) =>
      key === "backupService"
        ? { getBackupsPath: async () => backupsPath }
        : {},
  };
}

describe("POST /upload streamed route", () => {
  it("stores a valid upload and reports the streamed byte count", async () => {
    root = mkdtempSync(join(tmpdir(), "better-zcp-upload-route-"));
    const backupsPath = join(root, "backups");
    const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    getActiveServer.mockResolvedValue({ isRemote: false });
    const req = request([body.subarray(0, 1), body.subarray(1)]);
    req.app = app(backupsPath);
    const res = response();

    await uploadHandler()(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, name: "uploaded-world.zip", size: body.length }),
    );
    expect(readFileSync(join(backupsPath, "uploaded-world.zip")).equals(body)).toBe(true);
  });

  it("maps a bad streamed signature to the existing 400 API error", async () => {
    root = mkdtempSync(join(tmpdir(), "better-zcp-upload-route-"));
    const backupsPath = join(root, "backups");
    getActiveServer.mockResolvedValue({ isRemote: false });
    const req = request([Buffer.from("not a zip")]);
    req.app = app(backupsPath);
    const res = response();

    await uploadHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(readdirSync(backupsPath)).toEqual([]);
  });

  it("does not overwrite a same-name upload that lands while this one streams", async () => {
    root = mkdtempSync(join(tmpdir(), "better-zcp-upload-route-"));
    const backupsPath = join(root, "backups");
    const targetPath = join(backupsPath, "uploaded-world.zip");
    const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
    getActiveServer.mockResolvedValue({ isRemote: false });
    streamUploadToFileMock.mockImplementationOnce(async (_req, tmpPath: string) => {
      writeFileSync(targetPath, "concurrent winner");
      writeFileSync(tmpPath, body);
      return body.length;
    });
    const req = request([body]);
    req.app = app(backupsPath);
    const res = response();

    await uploadHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(readFileSync(targetPath, "utf8")).toBe("concurrent winner");
    expect(readdirSync(backupsPath)).toEqual(["uploaded-world.zip"]);
  });

  it("maps the stream size error to 413", async () => {
    root = mkdtempSync(join(tmpdir(), "better-zcp-upload-route-"));
    const backupsPath = join(root, "backups");
    getActiveServer.mockResolvedValue({ isRemote: false });
    streamUploadToFileMock.mockRejectedValueOnce(
      Object.assign(new Error("Upload exceeds the configured size limit."), {
        code: uploadStream.UPLOAD_TOO_LARGE_CODE,
      }),
    );
    const req = request([Buffer.from([0x50, 0x4b, 0x03, 0x04])]);
    req.app = app(backupsPath);
    const res = response();

    await uploadHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(413);
  });
});

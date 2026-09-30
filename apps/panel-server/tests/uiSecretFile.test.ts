import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";

let tmpDir;

vi.mock("../utils/paths.ts", () => ({
  getDataPaths: () => ({ dataDir: tmpDir }),
}));

const { readUiSecretFile, writeUiSecretFile } = await import(
  "../utils/uiSecretFile.ts"
);

describe("readUiSecretFile / writeUiSecretFile", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-uisecret-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    expect(readUiSecretFile("testToken")).toBeNull();
  });

  it("writes then reads back the same value", () => {
    writeUiSecretFile("testToken", "a-real-token");
    expect(readUiSecretFile("testToken")).toBe("a-real-token");
  });

  it("writing an empty/null value removes the file instead of leaving an empty one", () => {
    writeUiSecretFile("testToken", "something");
    expect(fs.existsSync(path.join(tmpDir, "testToken.secret"))).toBe(
      true,
    );
    writeUiSecretFile("testToken", "");
    expect(fs.existsSync(path.join(tmpDir, "testToken.secret"))).toBe(
      false,
    );
    expect(readUiSecretFile("testToken")).toBeNull();
  });

  it("rejects an unreadable file so saving settings cannot discard an existing credential", () => {
    const filePath = path.join(tmpDir, "testToken.secret");
    fs.mkdirSync(filePath);
    expect(() => readUiSecretFile("testToken")).toThrow();
  });
});

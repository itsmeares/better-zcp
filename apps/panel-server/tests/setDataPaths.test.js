import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const { getDataPaths, setDataPaths } = await import("../utils/paths.ts");

function freshDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zcp-setpaths-${label}-`));
}

describe("setDataPaths: path validation", () => {
  it("rejects a relative path instead of silently resolving it against the process's working directory", async () => {
    const result = await setDataPaths({ dataDir: "relative/subdir" }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/absolute/i);
  });

  it("still rejects a path under a blocked system directory (unchanged behavior)", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const result = await setDataPaths({ dataDir: "C:\\Windows\\zcp-test" }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/protected system directory/i);
  });

  it("rejects a target that is INSIDE a caller-supplied extraBlockedPaths entry", async () => {
    const pzInstall = freshDir("pz-install-inside");
    const target = path.join(pzInstall, "Server");
    const result = await setDataPaths(
      { dataDir: target },
      false,
      { extraBlockedPaths: [pzInstall] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/overlaps/i);
  });

  it("rejects a target that CONTAINS a caller-supplied extraBlockedPaths entry (the reverse direction)", async () => {
    const root = freshDir("ancestor-root");
    const pzInstall = path.join(root, "pz", "install");
    fs.mkdirSync(pzInstall, { recursive: true });
    const result = await setDataPaths(
      { dataDir: root },
      false,
      { extraBlockedPaths: [pzInstall] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/overlaps/i);
  });

  it("does not flag an unrelated directory as overlapping", async () => {
    const pzInstall = freshDir("pz-install-unrelated");
    const target = freshDir("unrelated-target");
    const result = await setDataPaths(
      { dataDir: target },
      false,
      { extraBlockedPaths: [pzInstall] },
    );
    expect(result.success).toBe(true);
  });
});

describe("setDataPaths: moveFiles defaults to false", () => {
  it("does NOT copy files when moveFiles is omitted entirely, even though the old dataDir has real content", async () => {
    const oldDir = freshDir("old-data-default");
    fs.writeFileSync(path.join(oldDir, "db.json"), "{}");
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);

    const newDir = freshDir("new-data-default");
    const result = await setDataPaths({ dataDir: newDir });
    expect(result.success).toBe(true);
    expect(result.filesMoved.data).toBe(false);
    expect(fs.existsSync(path.join(newDir, "db.json"))).toBe(false);
  });
});

describe("setDataPaths: the happy path really moves the database", () => {
  it("moves db.json to the new location when moveFiles is explicitly true", async () => {
    const oldDir = freshDir("old-data-move");
    fs.writeFileSync(path.join(oldDir, "db.json"), '{"real":true}');
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);

    const newDir = freshDir("new-data-move");
    const result = await setDataPaths({ dataDir: newDir }, true);
    expect(result.success).toBe(true);
    expect(result.filesMoved.data).toBe(true);
    expect(fs.readFileSync(path.join(newDir, "db.json"), "utf8")).toBe('{"real":true}');
  });
});

describe("setDataPaths: break-verify the anti-lockout guard against a real, reproducible partial-copy", () => {
  it("aborts BEFORE switching paths if the copy silently leaves db.json behind (e.g. a permissions quirk on that one file)", async () => {
    const oldDir = freshDir("old-data-partial");
    fs.writeFileSync(path.join(oldDir, "db.json"), '{"important":true}');
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);
    const pinnedDataDir = getDataPaths().dataDir;

    const newDir = freshDir("new-data-partial");
    const realCopyFileSync = fs.copyFileSync.bind(fs);
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest, ...rest) => {
      if (path.basename(src) === "db.json") return undefined;
      return realCopyFileSync(src, dest, ...rest);
    });

    let result;
    try {
      result = await setDataPaths({ dataDir: newDir }, true);
    } finally {
      copySpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not produce a database file/i);
    expect(getDataPaths().dataDir).toBe(pinnedDataDir);
    expect(fs.existsSync(path.join(oldDir, "db.json"))).toBe(true);
  });

  it("does NOT false-positive when the source legitimately has no database yet", async () => {
    const oldDir = freshDir("old-data-empty");
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);

    const newDir = freshDir("new-data-empty-target");
    const result = await setDataPaths({ dataDir: newDir }, true);
    expect(result.success).toBe(true);
  });
});

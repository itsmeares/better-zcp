import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  formatWritablePathError,
  formatDirectoryReadError,
} from "../routes/server.js";
import { ErrorCode } from "../utils/errorCodes.ts";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const EN_ERRORS = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "apps/panel-client/src/locales/en/errors.json"),
    "utf8",
  ),
);
const FR_ERRORS = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "apps/panel-client/src/locales/fr/errors.json"),
    "utf8",
  ),
);

function interpolate(template, params) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    expect(params, `template needs {{${name}}} but params is missing`).toBeTruthy();
    expect(
      Object.prototype.hasOwnProperty.call(params, name),
      `template needs {{${name}}} but params does not have it`,
    ).toBe(true);
    return String(params[name]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function mockNotContainerized() {
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    const err = new Error(
      "ENOENT: no such file or directory, open '/proc/1/cgroup'",
    );
    err.code = "ENOENT";
    throw err;
  });
}

describe("formatWritablePathError: variant split (2026-08-22 correction)", () => {
  it("install + bare-metal", () => {
    mockNotContainerized();
    const result = formatWritablePathError("install", "/srv/pz", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL);
    expect(result.params).toEqual({ path: "/srv/pz" });
    expect(result.message).toContain("chown");
    expect(result.message).toContain("chmod");
  });

  it("install + container (Docker PUID/PGID guidance)", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => p === "/.dockerenv",
    );
    const result = formatWritablePathError("install", "/srv/pz", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER);
    expect(result.params).toEqual({ path: "/srv/pz" });
    expect(result.message).toContain("PUID");
    expect(result.message).toContain("PGID");
    expect(result.message).toContain(".env");
  });

  it("data + bare-metal", () => {
    mockNotContainerized();
    const result = formatWritablePathError("data", "/srv/pz_Data", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_DATA_BAREMETAL);
    expect(result.params).toEqual({ path: "/srv/pz_Data" });
    expect(result.message).toContain("chown");
    expect(result.message).toContain("chmod");
  });

  it("data + container", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (p) => p === "/run/.containerenv",
    );
    const result = formatWritablePathError("data", "/srv/pz_Data", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_DATA_CONTAINER);
    expect(result.params).toEqual({ path: "/srv/pz_Data" });
    expect(result.message).toContain("PUID");
    expect(result.message).toContain("PGID");
    expect(result.message).toContain(".env");
  });

  it("container detection is skipped entirely on Windows, by design", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = formatWritablePathError("install", "/srv/pz", true);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL);
  });

  it.each([
    ["install", false, ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL],
    ["install", true, ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER],
    ["data", false, ErrorCode.WRITABLE_PATH_DATA_BAREMETAL],
    ["data", true, ErrorCode.WRITABLE_PATH_DATA_CONTAINER],
  ])(
    "%s/container=%s: en and fr both interpolate cleanly with the formatter's own params",
    (kind, container, expectedCode) => {
      if (container) {
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
      } else {
        mockNotContainerized();
      }
      const result = formatWritablePathError(kind, "/some/path", false);
      expect(result.code).toBe(expectedCode);
      expect(() => interpolate(EN_ERRORS[result.code], result.params)).not.toThrow();
      expect(() => interpolate(FR_ERRORS[result.code], result.params)).not.toThrow();
    },
  );

  it("detects a container via the cgroup fallback even when neither marker file exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/docker/abc123\n");
    const result = formatWritablePathError("data", "/srv/pz_Data", false);
    expect(result.code).toBe(ErrorCode.WRITABLE_PATH_DATA_CONTAINER);
    expect(result.message).toContain("PUID");
  });
});

describe("formatDirectoryReadError: variant split (2026-08-22 correction)", () => {
  it("windows guidance", () => {
    const result = formatDirectoryReadError("C:\\pz", "EPERM", true);
    expect(result.code).toBe(ErrorCode.DIRECTORY_READ_FAILED_WINDOWS);
    expect(result.params).toEqual({ path: "C:\\pz", code: "EPERM" });
    expect(result.message).toBe(
      "Cannot read C:\\pz (EPERM). Run the panel as an account that can read this folder.",
    );
  });

  it("posix guidance", () => {
    const result = formatDirectoryReadError("/srv/pz", "EACCES", false);
    expect(result.code).toBe(ErrorCode.DIRECTORY_READ_FAILED_POSIX);
    expect(result.params).toEqual({ path: "/srv/pz", code: "EACCES" });
    expect(result.message).toBe(
      "Cannot read /srv/pz (EACCES). The panel service account needs read and execute permission on this folder and every parent folder.",
    );
  });

  it.each([
    [true, ErrorCode.DIRECTORY_READ_FAILED_WINDOWS],
    [false, ErrorCode.DIRECTORY_READ_FAILED_POSIX],
  ])(
    "isWindows=%s: en and fr both interpolate cleanly with the formatter's own params",
    (isWin, expectedCode) => {
      const result = formatDirectoryReadError("/some/path", "EACCES", isWin);
      expect(result.code).toBe(expectedCode);
      expect(() => interpolate(EN_ERRORS[result.code], result.params)).not.toThrow();
      expect(() => interpolate(FR_ERRORS[result.code], result.params)).not.toThrow();
    },
  );
});

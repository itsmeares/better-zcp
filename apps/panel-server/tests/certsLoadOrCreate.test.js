import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadOrCreateCerts } from "../utils/certs.js";

// Regression coverage for the HTTPS-cert-path crash: a custom
// httpsCertPath/httpsKeyPath saved via Settings used to be read with a bare
// fs.existsSync + fs.readFileSync, and existsSync returns true for a
// DIRECTORY too -- so readFileSync on a directory (EISDIR) or an unreadable
// file threw straight out of this function, uncaught, all the way up to
// index.js's global uncaughtException handler, which kills the whole panel
// process. The fix must never let a bad custom path do that; it must fall
// back to a self-signed cert instead, exactly like the pre-existing
// "path doesn't exist" case already did.

let tempDir;

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
});

describe("loadOrCreateCerts -- custom path failure modes never throw", () => {
  it("falls back to self-signed when the custom paths point at a DIRECTORY, not a file (the crash case)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-certs-test-"));
    const dirAsKeyPath = tempDir;
    const dirAsCertPath = tempDir;

    let result;
    expect(() => {
      result = loadOrCreateCerts(dirAsKeyPath, dirAsCertPath);
    }).not.toThrow();

    // Falls all the way through to self-signed generation/reuse, so this
    // is non-null -- HTTPS still comes up, just not with the custom cert.
    expect(result).not.toBeNull();
    expect(result.key).toBeInstanceOf(Buffer);
    expect(result.cert).toBeInstanceOf(Buffer);
  });

  it("falls back to self-signed when the custom paths don't exist at all", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-certs-test-"));
    const missingKeyPath = path.join(tempDir, "does-not-exist.key");
    const missingCertPath = path.join(tempDir, "does-not-exist.cert");

    let result;
    expect(() => {
      result = loadOrCreateCerts(missingKeyPath, missingCertPath);
    }).not.toThrow();

    expect(result).not.toBeNull();
    expect(result.key).toBeInstanceOf(Buffer);
    expect(result.cert).toBeInstanceOf(Buffer);
  });

  it("still uses a VALID custom key/cert pair -- the fix must not disable the feature to stop the crash", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-certs-test-"));
    const keyPath = path.join(tempDir, "custom.key");
    const certPath = path.join(tempDir, "custom.cert");
    fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nfake-key-bytes\n-----END PRIVATE KEY-----\n");
    fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nfake-cert-bytes\n-----END CERTIFICATE-----\n");

    const result = loadOrCreateCerts(keyPath, certPath);

    expect(result).not.toBeNull();
    expect(result.key.toString("utf-8")).toContain("fake-key-bytes");
    expect(result.cert.toString("utf-8")).toContain("fake-cert-bytes");
  });

  it("falls back to self-signed when only one of the two custom paths is a real file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-certs-test-"));
    const realKeyPath = path.join(tempDir, "real.key");
    fs.writeFileSync(realKeyPath, "key bytes");
    const missingCertPath = path.join(tempDir, "missing.cert");

    let result;
    expect(() => {
      result = loadOrCreateCerts(realKeyPath, missingCertPath);
    }).not.toThrow();

    expect(result).not.toBeNull();
    // Must not be the real key bytes we wrote -- it fell through to self-signed.
    expect(result.key.toString("utf-8")).not.toContain("key bytes");
  });
});

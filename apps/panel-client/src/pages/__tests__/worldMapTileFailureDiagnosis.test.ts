import { describe, expect, it } from "vitest";
import {
  classifyTileBytes,
  diagnoseTileFailure,
  parseContentLength,
  tileFailureCopyKeys,
} from "../worldMapTileFailureDiagnosis";

describe("classifyTileBytes", () => {
  it("identifies gzip by its magic number", () => {
    expect(classifyTileBytes(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toEqual({ kind: "gzip" });
  });

  it("identifies a genuine JPEG by its SOI marker", () => {
    expect(classifyTileBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: "jpeg" });
  });

  it("identifies a genuine PNG by its full signature", () => {
    expect(classifyTileBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({ kind: "png" });
  });

  it("identifies an HTML document starting with <!DOCTYPE", () => {
    const bytes = new TextEncoder().encode("<!DOCTYPE html>");
    expect(classifyTileBytes(bytes)).toEqual({ kind: "html" });
  });

  it("identifies an HTML document starting with <html", () => {
    const bytes = new TextEncoder().encode("<html><head>");
    expect(classifyTileBytes(bytes)).toEqual({ kind: "html" });
  });

  it("identifies a JSON object", () => {
    const bytes = new TextEncoder().encode('{"error":"not found"}');
    expect(classifyTileBytes(bytes)).toEqual({ kind: "json" });
  });

  it("identifies a JSON array", () => {
    const bytes = new TextEncoder().encode("[1,2,3]");
    expect(classifyTileBytes(bytes)).toEqual({ kind: "json" });
  });

  it("reports an empty response distinctly from an unrecognised one", () => {
    expect(classifyTileBytes(new Uint8Array([]))).toEqual({ kind: "empty" });
  });

  it("falls back to raw hex, unmapped, for anything matching no known signature -- the point of the detector", () => {
    const result = classifyTileBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    expect(result).toEqual({ kind: "unrecognized", hex: "00 01 02 03" });
  });

  it("does not misclassify a near-miss as a real signature -- every byte of a signature must match", () => {
    // Looks gzip-ish (starts 1f) but the second byte is wrong.
    expect(classifyTileBytes(new Uint8Array([0x1f, 0x00]))).toEqual({ kind: "unrecognized", hex: "1f 00" });
    // Looks JPEG-ish (starts ff d8) but the third byte is wrong.
    expect(classifyTileBytes(new Uint8Array([0xff, 0xd8, 0x00]))).toEqual({ kind: "unrecognized", hex: "ff d8 00" });
    // Looks PNG-ish (starts 89 50 4e) but the fourth byte is wrong.
    expect(classifyTileBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x00]))).toEqual({
      kind: "unrecognized",
      hex: "89 50 4e 00",
    });
  });

  it("handles fewer bytes than a signature needs without crashing, and does not claim a match it can't verify", () => {
    expect(classifyTileBytes(new Uint8Array([0x1f]))).toEqual({ kind: "unrecognized", hex: "1f" });
    expect(classifyTileBytes(new Uint8Array([0xff, 0xd8]))).toEqual({ kind: "unrecognized", hex: "ff d8" });
  });
});

describe("parseContentLength", () => {
  it("parses a well-formed Content-Length as a plain integer", () => {
    expect(parseContentLength("18340")).toBe(18340);
    expect(parseContentLength("0")).toBe(0);
  });

  it("treats a malformed Content-Length the same as absent, never guesses a number from it", () => {
    expect(parseContentLength("not-a-number")).toBeNull();
    expect(parseContentLength("18340, 18340")).toBeNull(); // a list, from a misbehaving intermediary
    expect(parseContentLength("-5")).toBeNull();
    expect(parseContentLength("")).toBeNull();
    expect(parseContentLength(null)).toBeNull();
  });
});

describe("diagnoseTileFailure", () => {
  it("flags truncation when fewer bytes arrived than Content-Length declared, on genuine JPEG data", () => {
    const result = diagnoseTileFailure(new Uint8Array([0xff, 0xd8, 0xff]), 4192, "18340");
    expect(result.signature).toEqual({ kind: "jpeg" });
    expect(result.looksLikeTruncated).toBe(true);
    expect(result.receivedBytes).toBe(4192);
    expect(result.expectedBytes).toBe(18340);
  });

  it("does not flag truncation when the full declared size arrived", () => {
    const result = diagnoseTileFailure(new Uint8Array([0xff, 0xd8, 0xff]), 18340, "18340");
    expect(result.looksLikeTruncated).toBe(false);
  });

  it("does not flag truncation when MORE bytes arrived than declared -- not the failure this check is for", () => {
    const result = diagnoseTileFailure(new Uint8Array([0xff, 0xd8, 0xff]), 20000, "18340");
    expect(result.looksLikeTruncated).toBe(false);
  });

  it("cannot claim truncation when Content-Length is absent -- absence is not evidence of a specific size", () => {
    const result = diagnoseTileFailure(new Uint8Array([0xff, 0xd8, 0xff]), 4192, null);
    expect(result.looksLikeTruncated).toBe(false);
    expect(result.expectedBytes).toBeNull();
  });

  it("computes truncation and signature independently -- a gzip body can also be truncated", () => {
    const result = diagnoseTileFailure(new Uint8Array([0x1f, 0x8b]), 100, "5000");
    expect(result.signature).toEqual({ kind: "gzip" });
    expect(result.looksLikeTruncated).toBe(true);
  });
});

describe("tileFailureCopyKeys", () => {
  it("maps each recognised signature to its own title/desc key pair, hedged only for the ones that need it", () => {
    const cases: Array<[ReturnType<typeof classifyTileBytes>["kind"], string]> = [
      ["gzip", "tileFailure.gzipTitle"],
      ["html", "tileFailure.htmlTitle"],
      ["json", "tileFailure.jsonTitle"],
      ["png", "tileFailure.pngTitle"],
      ["empty", "tileFailure.emptyTitle"],
    ];
    for (const [kind, expectedTitleKey] of cases) {
      const keys = tileFailureCopyKeys({
        signature: { kind } as ReturnType<typeof classifyTileBytes>,
        looksLikeTruncated: false,
        receivedBytes: 100,
        expectedBytes: null,
      });
      expect(keys.titleKey).toBe(expectedTitleKey);
    }
  });

  it("routes genuine-but-incomplete JPEG data to the truncated key with byte counts, not a guess", () => {
    const keys = tileFailureCopyKeys({
      signature: { kind: "jpeg" },
      looksLikeTruncated: true,
      receivedBytes: 4192,
      expectedBytes: 18340,
    });
    expect(keys.titleKey).toBe("tileFailure.truncatedTitle");
    expect(keys.descParams).toEqual({ received: 4192, expected: 18340 });
  });

  it("routes genuine-and-complete-but-undecodable JPEG data to the corrupt key, not truncated", () => {
    const keys = tileFailureCopyKeys({
      signature: { kind: "jpeg" },
      looksLikeTruncated: false,
      receivedBytes: 18340,
      expectedBytes: 18340,
    });
    expect(keys.titleKey).toBe("tileFailure.corruptTitle");
    expect(keys.descParams).toBeUndefined();
  });

  it("routes an unrecognised signature to its key with the raw hex, never silently rounds into another bucket", () => {
    const keys = tileFailureCopyKeys({
      signature: { kind: "unrecognized", hex: "00 01 02 03" },
      looksLikeTruncated: false,
      receivedBytes: 4,
      expectedBytes: null,
    });
    expect(keys.titleKey).toBe("tileFailure.unrecognizedTitle");
    expect(keys.descParams).toEqual({ hex: "00 01 02 03" });
  });
});

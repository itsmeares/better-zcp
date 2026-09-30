import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelUpdateChecker, fetchReleaseResponse } from "../services/panelUpdateChecker.ts";
afterEach(() => vi.unstubAllGlobals());
describe("release transport", () => {
  it.each(["http://github.com/file", "https://example.org/file", "https://github.com.evil.org/file", "https://user:password@github.com/file", "https://github.com:444/file"])("refuses untrusted URL %s before requesting it", async url => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchReleaseResponse(url)).rejects.toThrow(/trusted GitHub/); expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks redirected destinations and releases the redirect body", async () => {
    const response = new Response("redirect", { status: 302, headers: { location: "https://example.org/file" } });
    const fetcher = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetcher);
    await expect(fetchReleaseResponse("https://github.com/file")).rejects.toThrow(/trusted GitHub/); expect(fetcher).toHaveBeenCalledTimes(1); expect(response.body!.locked).toBe(false);
  });
  it("cleans a real partial file when the response aborts mid-download", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-download-")), file = path.join(root, "package.zip");
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); setTimeout(() => controller.error(new Error("response aborted")), 30); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    try { await expect(new PanelUpdateChecker().downloadFile("https://github.com/file", file, 100)).rejects.toThrow(/response aborted/); expect(fs.existsSync(file)).toBe(false); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("clears the checking flag when a release response fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("response aborted")));
    const checker = new PanelUpdateChecker(); await checker.checkForUpdate(); expect(checker.isChecking).toBe(false); expect(checker.lastError).toBe("response aborted");
  });
  it("preserves RC tags and offers the stable release after its RC", () => {
    const checker = new PanelUpdateChecker(); expect(checker.extractVersion("v2.0.0-rc10")).toBe("2.0.0-rc10"); expect(checker.isNewer("2.0.0-rc10", "2.0.0-rc5")).toBe(true); expect(checker.isNewer("2.0.0", "2.0.0-rc10")).toBe(true); expect(checker.isNewer("2.0.0-rc10", "2.0.0")).toBe(false);
  });
  it.skipIf(process.platform === "win32")("rejects linked and oversized update reports without reading their contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-result-"));
    const checker = new PanelUpdateChecker(); checker.getExeBasePath = () => path.join(root, "panel");
    const result = path.join(root, "panel-update-result.json"), secret = path.join(root, "secret");
    try {
      fs.writeFileSync(secret, "private-data"); fs.symlinkSync(secret, result);
      expect(() => checker.readMostRecentApplyLog()).toThrow("bounded regular file");
      fs.unlinkSync(result); fs.writeFileSync(result, "x".repeat(65537));
      expect(() => checker.readMostRecentApplyLog()).toThrow("bounded regular file");
      fs.writeFileSync(result, '{"status":"success"}'); expect(checker.readMostRecentApplyLog()).toBe('{"status":"success"}');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

});

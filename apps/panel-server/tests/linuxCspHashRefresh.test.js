import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { contentSecurityPolicy } from "helmet";
import { computeInlineScriptCspHash } from "../utils/cspScriptHash.ts";
import { applyUpdateBundle, stageUpdateBundle } from "../services/updateBundle.ts";


function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function htmlWithScript(scriptBody) {
  return `<!DOCTYPE html>\n<html><head><script>${scriptBody}</script></head><body></body></html>\n`;
}

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader: (name, value) => {
      headers[name] = value;
    },
    getHeader: (name) => headers[name],
    getHeaders: () => headers,
    removeHeader: () => {},
    statusCode: 200,
  };
}

describe("computeInlineScriptCspHash() re-read after a real applyUpdateBundle() client swap", () => {
  let installDir;
  afterEach(() => {
    if (installDir) fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("tracks the new script after a real bundle apply, and the pre-apply hash would have been wrong if reused", () => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-csp-refresh-"));
    const binaryPath = path.join(installDir, "ZomboidControlPanel");
    const stagedBinaryPath = `${binaryPath}.new`;
    const liveClientPath = path.join(installDir, "client", "dist");
    const incomingClientPath = path.join(installDir, "incoming-client");

    writeFile(binaryPath, "old-binary");
    writeFile(stagedBinaryPath, "new-binary");
    writeFile(path.join(liveClientPath, "index.html"), htmlWithScript("var v='old';"));
    writeFile(
      path.join(incomingClientPath, "index.html"),
      htmlWithScript("var v='new'; console.log(v);"),
    );
    writeFile(
      path.join(incomingClientPath, "build-info.json"),
      JSON.stringify({ panelVersion: "2.0.0", buildSha: "new-build", apiContractVersion: 1 }),
    );

    const journalPath = stageUpdateBundle({
      installDir,
      version: "2.0.0",
      binaryPath,
      stagedBinaryPath,
      liveClientPath,
      incomingClientPath,
      metadata: { panelVersion: "2.0.0", buildSha: "new-build", apiContractVersion: 1 },
    });

    const hashBeforeApply = computeInlineScriptCspHash(liveClientPath);
    expect(hashBeforeApply).toBeTruthy();

    applyUpdateBundle(journalPath);
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toContain(
      "var v='new'",
    );

    const hashAfterApply = computeInlineScriptCspHash(liveClientPath);

    expect(hashBeforeApply).not.toBe(hashAfterApply);
    expect(hashAfterApply).toBe(computeInlineScriptCspHash(liveClientPath));
  });
});

describe("helmet's scriptSrc directive: function element vs. frozen array element", () => {
  it("a function element picks up a reassigned outer variable on the very next request -- the shape apps/panel-server/index.ts now uses", () => {
    let currentHash = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
    const middleware = contentSecurityPolicy({
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", () => currentHash],
      },
    });

    const res1 = fakeRes();
    middleware({}, res1, () => {});
    expect(res1.headers["Content-Security-Policy"]).toContain(
      "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );

    currentHash = "'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='";

    const res2 = fakeRes();
    middleware({}, res2, () => {});
    expect(res2.headers["Content-Security-Policy"]).toContain(
      "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    );
    expect(res2.headers["Content-Security-Policy"]).not.toContain(
      "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
  });

  it("contrast case: a plain string element (the pre-fix shape) stays frozen at whatever it was when app.use() ran, even after the same reassignment", () => {
    let currentHash = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
    const middleware = contentSecurityPolicy({
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: currentHash ? ["'self'", currentHash] : ["'self'"],
      },
    });

    currentHash = "'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='";

    const res = fakeRes();
    middleware({}, res, () => {});
    expect(res.headers["Content-Security-Policy"]).toContain(
      "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
  });
});

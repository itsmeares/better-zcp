import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { computeInlineScriptCspHash } from "../utils/cspScriptHash.ts";
import { applyUpdateBundle, stageUpdateBundle } from "../services/updateBundle.ts";


function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function htmlWithScript(scriptBody) {
  return `<!DOCTYPE html>\n<html><head><script>${scriptBody}</script></head><body></body></html>\n`;
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

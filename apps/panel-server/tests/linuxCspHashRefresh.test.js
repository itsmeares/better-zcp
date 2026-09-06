import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { contentSecurityPolicy } from "helmet";
import { computeInlineScriptCspHash } from "../utils/cspScriptHash.js";
import { applyUpdateBundle, stageUpdateBundle } from "../services/updateBundle.js";

// Linux bug hunt 2026-08-29, CSP inline-script hash card. The card's literal
// claim -- "the hash mismatches on every single page load" -- does NOT
// reproduce: a real `pnpm run build` + real server + real headless Chromium
// (verified manually, see outbox report) shows zero CSP violations for the
// shipped dist/index.html at current main. That was case (b) as the card
// itself distinguished it, and it's clean.
//
// But question 3 in the same card ("is the hash computed once at boot or
// per request? If at boot, a dist replaced by a self-update while the
// process runs would leave a stale hash") turned out to be a REAL, verified
// bug, just narrower than the card's headline claim. apps/panel-server/index.js
// computed the hash exactly once at module load and closed over that frozen
// value in a plain array passed to helmet. But the packaged LINUX
// update-apply path (POST /api/panel/restart, isPackaged && !isWindows &&
// staged) calls updateBundle.js's applyUpdateBundle() IN-PROCESS -- it
// fs.renameSync()s client/dist's live directory onto the new build while
// THIS SAME Node process keeps serving requests for roughly another second
// (a deliberate `setTimeout(..., 1000)` "let the response go out before we
// exit") before it actually exits. Confirmed manually: editing a running
// server's live client/dist/index.html without restarting it left the
// Content-Security-Policy header frozen at the pre-edit hash while the
// actually-served HTML already had the new script text -- real Chromium
// (headless, no CSP-disabling flags) then genuinely blocked the script,
// logging "Executing inline script violates ... Either ... a hash
// ('sha256-<the real new hash>') ... is required" naming exactly the hash
// the OLD, un-refreshed code should have been serving. On Windows this
// can't happen: the swap is done by an external supervisor only AFTER this
// process has already exited (see the comment on refreshInlineScriptCspHash
// in apps/panel-server/index.js).
//
// The fix (apps/panel-server/index.js): the frozen `const inlineScriptCspSource` and
// static array element became a `let` plus a small
// refreshInlineScriptCspHash() function, called right after every place
// that can swap client/dist while this process keeps running (the
// successful Linux apply, its accessErr rollback branch, its outer catch,
// and the boot-time version-mismatch rollback). The scriptSrc directive
// passes a FUNCTION element instead of a plain string, because helmet only
// re-evaluates function elements per request (node_modules/helmet's
// getHeaderValue) -- a plain array element is captured once, when
// app.use(helmet(...)) runs, and reassigning the outer variable afterward
// would never reach an already-built array.
//
// index.js itself is never imported directly by this test suite (it's a
// side-effect-heavy entrypoint -- starts DB, sockets, the HTTP listener --
// with no existing convention in this codebase for importing it whole; see
// setupTokenGate.test.js's router-level pattern instead). So this file
// proves the two halves the actual fix depends on, each against real
// library code:
//   1. computeInlineScriptCspHash(), called again after a REAL
//      applyUpdateBundle() swap (no updateBundle.js mocking), returns the
//      NEW content's hash -- proving the primitive refreshInlineScriptCspHash
//      calls is itself correct, and that the STALE value it replaces really
//      would have mismatched (the positive control).
//   2. helmet's real contentSecurityPolicy() middleware, built with the same
//      shape apps/panel-server/index.js now uses (a function directive element closing
//      over a `let`), actually emits a NEW header value on the very next
//      request after that outer variable is reassigned -- proving the
//      wiring pattern the fix relies on is real, not an assumption about
//      helmet's internals. Includes the OLD frozen-array shape as its own
//      contrasting case, so the test can't pass regardless of which shape
//      is used.

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
    // Confirms the fixture really did swap the live file (same assertion
    // style as panelUpdateDatabaseBackupLifecycle.test.js) before trusting
    // anything about the hash that follows.
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toContain(
      "var v='new'",
    );

    const hashAfterApply = computeInlineScriptCspHash(liveClientPath);

    // The bug, reproduced directly: the OLD code's frozen value would still
    // be hashBeforeApply here, and that no longer matches what's on disk --
    // exactly the mismatch a real browser blocked in the manual repro.
    expect(hashBeforeApply).not.toBe(hashAfterApply);
    // The fix's primitive, proven: calling computeInlineScriptCspHash()
    // again (what refreshInlineScriptCspHash() does) picks up the real new
    // content instead of staying pinned to the pre-swap script.
    expect(hashAfterApply).toBe(computeInlineScriptCspHash(liveClientPath));
  });
});

describe("helmet's scriptSrc directive: function element vs. frozen array element", () => {
  it("a function element picks up a reassigned outer variable on the very next request -- the shape apps/panel-server/index.js now uses", () => {
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

    // Simulates refreshInlineScriptCspHash() reassigning the module-level
    // variable after an in-process client/dist swap.
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
    // This is exactly apps/panel-server/index.js's OLD construction: the ternary reads
    // currentHash ONCE, right now, and bakes the resulting string into the
    // array helmet receives -- reassigning currentHash below can never
    // reach it again.
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
    // Still the OLD value -- this is the bug this test file's first
    // describe block reproduced with a real file swap, now shown at the
    // header-construction layer: a frozen array element cannot observe a
    // later reassignment, which is exactly why the fix had to switch to a
    // function element instead of just changing const to let.
    expect(res.headers["Content-Security-Policy"]).toContain(
      "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
  });
});

/**
 * Hashes the panel's one inline <script> (the anti-FOUC theme-flash-
 * prevention bootstrap in apps/panel-client/index.html — sets the theme class before
 * first paint, see that file's own comment) so index.js's CSP can allow
 * exactly that script by a sha256 source instead of 'unsafe-inline'.
 *
 * Computed at server startup by reading the built dist/index.html, not
 * hardcoded: a hardcoded hash would silently break the theme system for
 * every user the next time anyone edits that script — a flash of the
 * wrong theme, no error, nothing in the log, in a change that looks
 * unrelated to CSP. Reading and hashing the real shipped file makes the
 * fix self-maintaining.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// A bare `<script>` with no attributes — deliberately narrow rather than a
// general HTML parser, so this can only ever match the one inline classic
// script. The module-loaded app bundle tag (`<script type="module" ...>`)
// has attributes and never matches this literal pattern.
const INLINE_SCRIPT_RE = /<script>([\s\S]*?)<\/script>/;

/**
 * Returns a CSP `'sha256-...'` source string for the inline bootstrap
 * script, or null if it couldn't be found (dist not built, the tag
 * renamed/restructured, the file moved). Callers must NOT fall back to
 * 'unsafe-inline' on null — see index.js's CSP setup for why: a missing
 * script here means the protection should visibly do nothing rather than
 * invisibly loosen.
 */
export function computeInlineScriptCspHash(clientDistPath, log) {
  const indexPath = path.join(clientDistPath, "index.html");
  let html;
  try {
    html = fs.readFileSync(indexPath, "utf8");
  } catch (err) {
    log?.warn?.(
      `CSP: could not read ${indexPath} to hash the inline bootstrap ` +
        `script (${err.message}). script-src will NOT allow inline ` +
        "scripts until this is fixed — the anti-FOUC script (and any " +
        "other inline script) will be blocked by the browser. This " +
        "usually means the client hasn't been built (pnpm run build) or " +
        "dist has moved.",
    );
    return null;
  }

  const match = INLINE_SCRIPT_RE.exec(html);
  if (!match) {
    log?.warn?.(
      `CSP: no inline <script> block found in ${indexPath} to hash. ` +
        "script-src will NOT allow inline scripts until this is fixed — " +
        "if index.html still has an inline script under a different " +
        "shape, it will be blocked by the browser.",
    );
    return null;
  }

  // Browsers newline-normalize script text (CRLF/CR -> LF) during HTML
  // parsing before computing the CSP hash, per spec. Hashing the raw bytes
  // here would compute the wrong hash on any checkout where this source
  // file has CRLF line endings (e.g. git's core.autocrlf=true on Windows,
  // the default on many dev machines) — the browser blocks the script with
  // a CSP violation because its own (correctly normalized) hash never
  // matches ours.
  const normalized = match[1].replace(/\r\n?/g, "\n");
  const digest = crypto
    .createHash("sha256")
    .update(normalized, "utf8")
    .digest("base64");
  return `'sha256-${digest}'`;
}

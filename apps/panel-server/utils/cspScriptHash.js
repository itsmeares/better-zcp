
import fs from "fs";
import path from "path";
import crypto from "crypto";

const INLINE_SCRIPT_RE = /<script>([\s\S]*?)<\/script>/;

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

  const normalized = match[1].replace(/\r\n?/g, "\n");
  const digest = crypto
    .createHash("sha256")
    .update(normalized, "utf8")
    .digest("base64");
  return `'sha256-${digest}'`;
}

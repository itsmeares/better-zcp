import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INLINE_SCRIPT_RE = /<script>([\s\S]*?)<\/script>/;

interface CspLogger {
  warn(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function computeInlineScriptCspHash(
  clientDistPath: string,
  log?: CspLogger | null,
): string | null {
  const indexPath = path.join(clientDistPath, "index.html");
  let html: string;
  try {
    html = fs.readFileSync(indexPath, "utf8");
  } catch (error: unknown) {
    log?.warn(
      `CSP: could not read ${indexPath} to hash the inline bootstrap ` +
        `script (${errorMessage(error)}). script-src will NOT allow inline ` +
        "scripts until this is fixed — the anti-FOUC script (and any " +
        "other inline script) will be blocked by the browser. This " +
        "usually means the client hasn't been built (pnpm run build) or " +
        "dist has moved.",
    );
    return null;
  }

  const match = INLINE_SCRIPT_RE.exec(html);
  if (!match) {
    log?.warn(
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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INLINE_SCRIPT_RE =
  /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
const INLINE_SCRIPT_OPEN_TAG_RE = /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>/gi;

interface CspLogger {
  warn(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function computeInlineScriptCspHashes(
  clientDistPath: string,
  log?: CspLogger | null,
): string[] {
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
    return [];
  }

  const hashes = computeInlineScriptCspHashesFromHtml(html);
  if (hashes.length === 0) {
    log?.warn(
      `CSP: no inline <script> block found in ${indexPath} to hash. ` +
        "script-src will NOT allow inline scripts until this is fixed — " +
        "if index.html still has an inline script under a different " +
        "shape, it will be blocked by the browser.",
    );
    return [];
  }

  return hashes;
}

export function computeInlineScriptCspHashesFromHtml(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT_RE)].map((match) => {
    const normalized = match[1].replace(/\r\n?/g, "\n");
    const digest = crypto
      .createHash("sha256")
      .update(normalized, "utf8")
      .digest("base64");
    return `'sha256-${digest}'`;
  });
}

export function addInlineScriptCspNonce(html: string, nonce: string): string {
  return html.replace(INLINE_SCRIPT_OPEN_TAG_RE, (tag) => {
    if (/\bnonce\s*=/i.test(tag)) return tag;
    return tag.replace(/^<script\b/i, `<script nonce="${nonce}"`);
  });
}

export function appendCspScriptHashes(
  cspHeader: string,
  hashes: readonly string[],
): string {
  if (hashes.length === 0) return cspHeader;

  const directives = cspHeader.split(";");
  const scriptSrcIndex = directives.findIndex((directive) =>
    /^\s*script-src(?:\s|$)/i.test(directive),
  );
  if (scriptSrcIndex === -1) return cspHeader;

  const directive = directives[scriptSrcIndex].trim();
  const existing = new Set(directive.split(/\s+/).slice(1));
  const additions = hashes.filter((hash) => !existing.has(hash));
  if (additions.length === 0) return cspHeader;

  directives[scriptSrcIndex] = `${directive} ${additions.join(" ")}`;
  return directives.join("; ");
}

export function appendCspScriptNonce(cspHeader: string, nonce: string): string {
  return appendCspScriptHashes(cspHeader, [`'nonce-${nonce}'`]);
}

export function computeInlineScriptCspHash(
  clientDistPath: string,
  log?: CspLogger | null,
): string | null {
  return computeInlineScriptCspHashes(clientDistPath, log)[0] ?? null;
}

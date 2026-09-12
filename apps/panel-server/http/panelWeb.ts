import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import {
  addInlineScriptCspNonce,
  appendCspScriptHashes,
  appendCspScriptNonce,
  computeInlineScriptCspHashesFromHtml,
} from "../utils/cspScriptHash.ts";
import {
  loadTanStackStartHandler,
  toTanStackStartRequest,
  type TanStackStartHandler,
} from "../utils/tanstackStartServer.ts";
import {
  clientDistMatchesMetadata,
  readClientDistMetadata,
} from "../utils/embeddedClient.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import type { TrustProxySetting } from "../utils/trustProxy.ts";

type AnyRecord = Record<string, any>;

type BuildMetadata = {
  panelVersion: string;
  buildSha: string;
  apiContractVersion: number;
};

type PanelWebLogger = {
  debug: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

type ErrorRequest = {
  method?: string;
  path: string;
};

type ErrorResponse = {
  status(code: number): ErrorResponse;
  json(body: unknown): ErrorResponse;
};

const REGISTERED_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

function isRegisteredErrorCode(value: unknown): value is string {
  return typeof value === "string" && REGISTERED_ERROR_CODES.has(value);
}
export type PanelWebOptions = {
  isPackaged: boolean;
  clientDistPath: string;
  externalClientDistPath: string;
  embeddedClientDistPath: string | null;
  buildMetadata: BuildMetadata;
  logger: PanelWebLogger;
  httpsDetected?: boolean;
  inlineScriptCspSources?: () => string;
};

function createTanStackStartHandlerLoader(
  options: PanelWebOptions,
): () => Promise<TanStackStartHandler | null> {
  const serverPath = options.isPackaged
    ? path.join(options.externalClientDistPath, ".start-server", "server.js")
    : path.join(options.clientDistPath, "../dist-start-server/server.js");
  let handlerPromise: Promise<TanStackStartHandler | null> | undefined;

  return async () => {
    if (!fs.existsSync(serverPath)) return null;
    handlerPromise ??= loadTanStackStartHandler(serverPath).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn(
          `TanStack Start server bundle could not be loaded (${message}); using the static client shell`,
        );
        return null;
      },
    );
    return handlerPromise;
  };
}

function buildLegacyClientRecoveryPage(
  options: PanelWebOptions,
  legacyClientMetadata: ReturnType<typeof readClientDistMetadata>,
): string {
  const escapeHtml = (value: unknown): string =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const frontendMetadata = legacyClientMetadata || "unavailable";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Panel update required</title></head>
<body><main>
<h1>Panel update required</h1>
<p>The executable and web interface are from different releases.</p>
<p>Executable: ${escapeHtml(`${options.buildMetadata.panelVersion} / ${options.buildMetadata.buildSha.slice(0, 12)}`)}</p>
<p>Frontend: ${escapeHtml(typeof frontendMetadata === "string" ? frontendMetadata : `${frontendMetadata.panelVersion} / ${frontendMetadata.buildSha.slice(0, 12)}`)}</p>
<p>Download the latest full package, extract it over this installation without replacing the <code>data</code> folder, then start the panel again.</p>
<p><a href="https://github.com/itsmeares/better-zcp/releases/latest">Download the latest release</a></p>
</main></body>
</html>`;
}

export function apiErrorHandler(
  logger: PanelWebLogger,
  err: AnyRecord,
  req: ErrorRequest,
  res: ErrorResponse,
  _next: (error?: unknown) => void,
): void {
  logger.error(`Unhandled API error on ${req.method} ${req.path}: ${err.message}`);
  const status = err.status || 500;
  const body: AnyRecord = { error: sanitizeError(err.message) };
  if (isRegisteredErrorCode(err.code)) {
    body.code = err.code;
  }
  res.status(status).json(body);
}

type NativeRequest = Omit<IncomingMessage, "method"> & {
  method: string;
  ip?: string;
  protocol?: string;
  secure?: boolean;
  originalUrl?: string;
  path?: string;
  app?: { get(name: string): unknown };
  get?: (name: string) => string | undefined;
};

type NativeSecurityOptions = {
  isAllowedOrigin?: (origin: unknown) => boolean;
  recordCorsBlock?: (origin: unknown, source: string) => void;
  trustProxy?: TrustProxySetting;
};

const STRICT_RATE_LIMIT_PATHS = [
  "/api/server/install",
  "/api/server/delete-files",
  "/api/server/wipe",
  "/api/server/steam-update",
  "/api/server/steamcmd/download",
  "/api/server/start",
  "/api/server/stop",
  "/api/server/force-stop",
  "/api/server/restart",
  "/api/docker/containers",
  "/api/backup/restore",
  "/api/backup/delete-older-than",
  "/api/backup/upload",
  "/api/chunks/delete-chunks",
  "/api/chunks/delete-region",
  "/api/server-files/raw",
  "/api/server-files/restore",
  "/api/server-files/save-and-reload",
  "/api/panel-bridge/install-mod",
  "/api/panel-bridge/install-local",
  "/api/panel-bridge/character/export",
  "/api/panel-bridge/character/import",
  "/api/panel/update-check",
  "/api/panel/update-download",
  "/api/panel/update-preflight",
  "/api/panel/restart",
  "/api/mods/collection/extract-cookies",
];

type NativeRateBucket = { count: number; resetAt: number };

function headerString(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIp(value: string): string {
  const ip = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function ipv4ToNumber(value: string): number {
  return value.split(".").reduce((result, part) => result * 256 + Number(part), 0) >>> 0;
}

function expandIpv6(value: string): number[] | null {
  const parts = value.split("::");
  if (parts.length > 2) return null;
  const expand = (part: string): number[] => {
    if (!part) return [];
    if (part.includes(".")) {
      const octets = part.split(".").map(Number);
      if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return [];
      return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    }
    return part.split(":").map((chunk) => Number.parseInt(chunk, 16));
  };
  const left = expand(parts[0]);
  const right = parts.length === 2 ? expand(parts[1]) : [];
  if (left.length + right.length > 8 || left.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff) || right.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  const middle = parts.length === 2 ? new Array(8 - left.length - right.length).fill(0) : [];
  const result = [...left, ...middle, ...right];
  return result.length === 8 ? result : null;
}

function ipMatchesRange(address: string, range: string): boolean {
  const [rangeAddress, bitsText] = range.split("/", 2);
  const normalizedAddress = normalizeIp(address);
  const normalizedRange = normalizeIp(rangeAddress);
  if (bitsText === undefined) return normalizedAddress === normalizedRange;

  const bits = Number(bitsText);
  const addressVersion = isIP(normalizedAddress);
  const rangeVersion = isIP(normalizedRange);
  if (!Number.isInteger(bits) || addressVersion !== rangeVersion) return false;
  if (addressVersion === 4 && bits >= 0 && bits <= 32) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4ToNumber(normalizedAddress) & mask) === (ipv4ToNumber(normalizedRange) & mask);
  }
  if (addressVersion !== 6 || bits < 0 || bits > 128) return false;
  const addressParts = expandIpv6(normalizedAddress);
  const rangeParts = expandIpv6(normalizedRange);
  if (!addressParts || !rangeParts) return false;
  const fullWords = Math.floor(bits / 16);
  const remainingBits = bits % 16;
  for (let index = 0; index < fullWords; index += 1) {
    if (addressParts[index] !== rangeParts[index]) return false;
  }
  return remainingBits === 0 ||
    (addressParts[fullWords] >> (16 - remainingBits)) === (rangeParts[fullWords] >> (16 - remainingBits));
}

function trustsProxy(address: string, trustProxy: TrustProxySetting | undefined, hop: number): boolean {
  if (typeof trustProxy === "number") return hop < trustProxy;
  const ranges = Array.isArray(trustProxy) ? trustProxy : trustProxy ? [trustProxy] : [];
  return ranges.some((range) => ipMatchesRange(address, range));
}

function resolveNativeClientIp(
  request: IncomingMessage,
  trustProxy: TrustProxySetting | undefined,
): string {
  const remoteAddress = request.socket.remoteAddress || "unknown";
  const forwarded = headerString(request, "x-forwarded-for");
  if (!trustProxy || !forwarded) return remoteAddress;
  const addresses = forwarded.split(",").map((value) => value.trim()).filter(Boolean).reverse();
  if (addresses.length === 0) return remoteAddress;
  const chain = [remoteAddress, ...addresses];
  let index = 0;
  while (index < chain.length - 1 && trustsProxy(chain[index], trustProxy, index)) index += 1;
  return chain[index] || remoteAddress;
}

function prepareNativeRequest(
  request: IncomingMessage,
  options: NativeSecurityOptions,
): NativeRequest {
  const nativeRequest = request as NativeRequest;
  const trustProxy = options.trustProxy;
  const forwardedProtocol = trustProxy && trustsProxy(request.socket.remoteAddress || "unknown", trustProxy, 0)
    ? headerString(request, "x-forwarded-proto")
    : undefined;
  const protocol = (request.socket as any).encrypted
    ? "https"
    : forwardedProtocol?.split(",", 1)[0]?.trim() || "http";
  const url = request.url || "/";
  const pathname = new URL(url, protocol + "://panel.invalid").pathname;
  const ip = resolveNativeClientIp(request, trustProxy);
  nativeRequest.ip = ip;
  nativeRequest.protocol = protocol;
  nativeRequest.secure = protocol === "https";
  nativeRequest.originalUrl = url;
  nativeRequest.path = pathname;
  nativeRequest.app = {
    get(name: string) {
      if (name === "trust proxy") return trustProxy;
      return undefined;
    },
  };
  nativeRequest.get = (name: string) => headerString(request, name);
  return nativeRequest;
}

function setSecurityHeaders(
  response: ServerResponse,
  options: PanelWebOptions,
): void {
  response.setHeader("Content-Security-Policy", buildCspHeader(options));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), interest-cohort=()");
  if (options.httpsDetected) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
}

function buildCspHeader(options: PanelWebOptions): string {
  const scriptSources = options.inlineScriptCspSources?.() || "";
  return [
    "default-src 'self'",
    "script-src 'self'" + (scriptSources ? " " + scriptSources : ""),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' ws: wss:",
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    ...(options.httpsDetected ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function setCorsHeaders(
  response: ServerResponse,
  request: IncomingMessage,
  options: NativeSecurityOptions,
): boolean {
  const origin = headerString(request, "origin");
  if (!origin) return true;
  if (!options.isAllowedOrigin || options.isAllowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", headerString(request, "access-control-request-headers") || "Authorization, Content-Type");
    response.setHeader("Vary", "Origin");
    return true;
  }
  options.recordCorsBlock?.(origin, "http");
  return false;
}

function sendNativeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(payload.length));
  response.end(payload);
}

function responseHasHtml(response: globalThis.Response): boolean {
  return (response.headers.get("content-type") || "").includes("text/html");
}

async function addHtmlCsp(
  response: globalThis.Response,
  options: PanelWebOptions,
): Promise<globalThis.Response> {
  if (!responseHasHtml(response)) return response;
  const html = await response.text();
  const headers = new Headers(response.headers);
  const hashes = computeInlineScriptCspHashesFromHtml(html);
  const nonce =
    hashes.length > 0 ? crypto.randomBytes(16).toString("base64") : null;
  const responseHtml = nonce ? addInlineScriptCspNonce(html, nonce) : html;
  const baseCsp =
    headers.get("content-security-policy") || buildCspHeader(options);
  const cspWithHashes = appendCspScriptHashes(baseCsp, hashes);
  const csp = nonce
    ? appendCspScriptNonce(cspWithHashes, nonce)
    : cspWithHashes;
  headers.set("content-security-policy", csp);
  headers.set("content-length", String(Buffer.byteLength(responseHtml)));
  return new globalThis.Response(responseHtml, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function sendNativeResponse(
  response: globalThis.Response,
  request: IncomingMessage,
  nodeResponse: ServerResponse,
): Promise<void> {
  const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  response.headers.forEach((value, name) => {
    if (name === "set-cookie" && setCookies?.length) return;
    nodeResponse.setHeader(name, value);
  });
  if (setCookies?.length) nodeResponse.setHeader("set-cookie", setCookies);
  nodeResponse.statusCode = response.status;
  if (request.method === "HEAD" || !response.body) {
    response.body?.cancel().catch(() => {});
    nodeResponse.end();
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  const declaredLength = response.headers.get("content-length");
  const contentLength = declaredLength ? Number(declaredLength) : NaN;
  const canCompress = !response.headers.get("content-encoding") &&
    !response.headers.has("content-disposition") &&
    !contentType.includes("text/event-stream") &&
    !contentType.startsWith("image/") &&
    !contentType.includes("application/zip") &&
    Boolean(declaredLength && Number.isFinite(contentLength) && contentLength >= 1024) &&
    /(?:^|,)\s*gzip\s*(?:,|$)/i.test(headerString(request, "accept-encoding") || "");
  if (canCompress) {
    nodeResponse.removeHeader("content-length");
    nodeResponse.setHeader("Content-Encoding", "gzip");
    nodeResponse.setHeader("Vary", "Accept-Encoding");
  }
  const source = Readable.fromWeb(response.body as any);
  if (canCompress) await pipeline(source, createGzip(), nodeResponse);
  else await pipeline(source, nodeResponse);
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

function isStaticAssetPath(pathname: string): boolean {
  return pathname.startsWith("/assets/") || path.extname(pathname) !== "";
}

async function sendStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  requestedPath: string,
  options: PanelWebOptions,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    return false;
  }
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, "." + decodedPath);
  if (!filePath.startsWith(rootPath + path.sep)) return false;
  let file;
  try {
    file = await fs.promises.open(filePath, "r");
  } catch {
    return false;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return false;
    response.setHeader("Content-Type", mimeType(filePath));
    response.setHeader("Content-Length", String(stats.size));
    response.setHeader("Cache-Control", filePath.endsWith(".html")
      ? "no-cache"
      : "public, max-age=604800, immutable");
    if (filePath.endsWith(".html")) {
      response.removeHeader("Content-Length");
      const html = await file.readFile("utf8");
      const startResponse = await addHtmlCsp(new globalThis.Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }), options);
      await sendNativeResponse(startResponse, request, response);
    } else if (request.method === "HEAD") {
      response.end();
    } else {
      await pipeline(file.createReadStream(), response);
    }
  } finally {
    await file.close().catch(() => {});
  }
  return true;
}

function rateLimited(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  buckets: Map<string, NativeRateBucket>,
): { status: number; body: unknown } | null {
  const ip = (request as NativeRequest).ip || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const hit = (key: string, max: number, body: unknown) => {
    const bucketKey = key + ":" + ip;
    const previous = buckets.get(bucketKey);
    const bucket = previous && previous.resetAt > now
      ? previous
      : { count: 0, resetAt: now + 60000 };
    bucket.count += 1;
    buckets.set(bucketKey, bucket);
    response.setHeader("RateLimit-Limit", String(max));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    response.setHeader("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return bucket.count > max ? { status: 429, body } : null;
  };
  const globalLimit = hit("api", 300, { error: "Too many requests, please try again later." });
  if (globalLimit) return globalLimit;
  const strict = STRICT_RATE_LIMIT_PATHS.some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix),
  ) ||
    (request.method === "DELETE" && /^\/api\/backup\/[^/]+$/.test(pathname)) ||
    /^\/api\/templates\/[^/]+\/apply$/.test(pathname);
  if (strict) {
    const result = hit("strict", 10, { error: "Rate limit exceeded for this operation." });
    if (result) return result;
  }
  if (pathname.startsWith("/api/mods/collection/items")) {
    const result = hit("collection", 60, { error: "Too many collection changes. Please wait a minute and try again." });
    if (result) return result;
  }
  if (pathname === "/api/rcon/execute") {
    const result = hit("rcon", 60, { error: "Too many RCON commands, please slow down." });
    if (result) return result;
  }
  if (pathname === "/api/panel-bridge/command") {
    const result = hit("bridge", 60, { error: "Too many PanelBridge commands, please slow down." });
    if (result) return result;
  }
  if (pathname === "/api/debug/client-errors") {
    const result = hit("client-errors", 10, { error: "Too many error reports, please slow down." });
    if (result) return result;
  }
  return null;
}

export function createPanelRequestHandler(
  options: PanelWebOptions,
  security: NativeSecurityOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const getHandler = createTanStackStartHandlerLoader(options);
  const rateBuckets = new Map<string, NativeRateBucket>();
  const legacyClientMetadata =
    options.isPackaged && !options.embeddedClientDistPath
      ? readClientDistMetadata(options.clientDistPath)
      : null;
  const legacyClientMismatch =
    options.isPackaged &&
    !options.embeddedClientDistPath &&
    !clientDistMatchesMetadata(options.clientDistPath, options.buildMetadata);

  return async (request, response) => {
    const nativeRequest = prepareNativeRequest(request, security);
    setSecurityHeaders(response, options);
    if (!setCorsHeaders(response, request, security)) {
      sendNativeJson(response, 403, { error: "Origin blocked by panel CORS policy." });
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const requestUrl = new URL(request.url || "/", nativeRequest.protocol + "://localhost");
    const pathname = requestUrl.pathname;
    const isApiRequest = pathname.startsWith("/api");
    if (isApiRequest) {
      const limit = rateLimited(request, response, pathname, rateBuckets);
      if (limit) {
        sendNativeJson(response, limit.status, limit.body);
        return;
      }
    }

    if (legacyClientMismatch && !isApiRequest) {
      response.statusCode = 503;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(buildLegacyClientRecoveryPage(options, legacyClientMetadata));
      return;
    }

    if (
      !isApiRequest &&
      !pathname.startsWith("/_serverFn/") &&
      (request.method === "GET" || request.method === "HEAD") &&
      isStaticAssetPath(pathname) &&
      await sendStaticFile(request, response, options.clientDistPath, pathname, options)
    ) {
      return;
    }

    const handler = await getHandler();
    if (pathname.startsWith("/_serverFn/") || isApiRequest || (request.method === "GET" || request.method === "HEAD")) {
      if (!handler) {
        if (pathname.startsWith("/_serverFn/") || isApiRequest) {
          sendNativeJson(response, 503, {
            error: "TanStack Start server bundle unavailable",
          });
          return;
        }
      } else {
        try {
          let startResponse = await handler.fetch(toTanStackStartRequest(nativeRequest));
          const startIsHtml = responseHasHtml(startResponse);
          if (!isApiRequest && startIsHtml) {
            startResponse = await addHtmlCsp(startResponse, options);
          }
          startResponse.headers.delete("x-tanstack-start-handled");
          if (isApiRequest || pathname.startsWith("/_serverFn/") || startResponse.status !== 404 || startIsHtml) {
            await sendNativeResponse(startResponse, request, response);
            return;
          }
        } catch (error) {
          options.logger.warn("TanStack Start request failed: " + (error instanceof Error ? error.message : String(error)));
          if (pathname.startsWith("/_serverFn/") || isApiRequest) {
            sendNativeJson(response, 503, { error: "TanStack Start request unavailable" });
            return;
          }
        }
      }
    }

    if (await sendStaticFile(request, response, options.clientDistPath, pathname, options)) return;
    if (await sendStaticFile(request, response, options.clientDistPath, "/index.html", options)) return;
    sendNativeJson(response, 404, { error: "Page not found" });
  };
}

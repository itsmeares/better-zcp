import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { getPanelRuntime } from "../utils/panelRuntime.ts";
import authService from "../services/auth.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import type { StartApiRouter, Request, Response } from "./startApiRouter.ts";

const REGISTERED_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

export function isRegisteredErrorCode(value: unknown): value is string {
  return typeof value === "string" && REGISTERED_ERROR_CODES.has(value);
}

type RouteModule = {
  base: string;
  load: () => Promise<StartApiRouter>;
};

type RouteModuleLoader = () => Promise<unknown>;

const routeFiles = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, RouteModuleLoader>;
  }
).glob("../routes/*.ts");

function loadRouteModule(path: string): () => Promise<StartApiRouter> {
  const load = routeFiles[path];
  return async () => {
    const module = await load?.();
    const router = (module as { default?: StartApiRouter } | undefined)?.default;
    if (!router) throw new Error(`Start API route module is unavailable: ${path}`);
    return router;
  };
}

const routeModules: RouteModule[] = [
  { base: "/api/auth/oidc", load: loadRouteModule("../routes/oidc.ts") },
  { base: "/api/auth", load: loadRouteModule("../routes/auth.ts") },
  { base: "/api/rcon", load: loadRouteModule("../routes/rcon.ts") },
  { base: "/api/server", load: loadRouteModule("../routes/server.ts") },
  { base: "/api/servers", load: loadRouteModule("../routes/servers.ts") },
  { base: "/api/players", load: loadRouteModule("../routes/players.ts") },
  { base: "/api/mods", load: loadRouteModule("../routes/mods.ts") },
  { base: "/api/server-files", load: loadRouteModule("../routes/serverFiles.ts") },
  { base: "/api/chunks", load: loadRouteModule("../routes/chunks.ts") },
  { base: "/api/debug", load: loadRouteModule("../routes/debug.ts") },
  { base: "/api/backup", load: loadRouteModule("../routes/backup.ts") },
  { base: "/api/map", load: loadRouteModule("../routes/mapProxy.ts") },
  { base: "/api/config", load: loadRouteModule("../routes/config.ts") },
  { base: "/api/docker", load: loadRouteModule("../routes/docker.ts") },
  { base: "/api/discovery", load: loadRouteModule("../routes/discovery.ts") },
  { base: "/api/server-finder", load: loadRouteModule("../routes/serverFinder.ts") },
  { base: "/api/permissions", load: loadRouteModule("../routes/permissions.ts") },
  { base: "/api/scheduler", load: loadRouteModule("../routes/scheduler.ts") },
  { base: "/api/system", load: loadRouteModule("../routes/system.ts") },
  { base: "/api/templates", load: loadRouteModule("../routes/templates.ts") },
  { base: "/api/discord", load: loadRouteModule("../routes/discord.ts") },
  { base: "/api/panel-bridge", load: loadRouteModule("../routes/panelBridge.ts") },
  { base: "/api/server-status", load: loadRouteModule("../routes/serverStatus.ts") },
];

export function registerStartApiModule(
  base: string,
  load: () => Promise<StartApiRouter>,
): void {
  routeModules.push({ base, load });
}

const PUBLIC_API_PATHS = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/reset-status",
  "/api/auth/reset-token/local",
  "/api/auth/reset-password",
  "/api/auth/recovery-status",
  "/api/auth/recover-with-code",
  "/api/auth/oidc/status",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
  "/api/health",
]);

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") || []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function serializeCookie(name: string, value: unknown, options: any = {}): string {
  let cookie = encodeURIComponent(name) + "=" + encodeURIComponent(String(value ?? ""));
  if (typeof options.maxAge === "number" && Number.isFinite(options.maxAge)) {
    cookie += "; Max-Age=" + Math.max(0, Math.floor(options.maxAge / 1000));
  }
  if (typeof options.domain === "string") cookie += "; Domain=" + options.domain;
  if (typeof options.path === "string") cookie += "; Path=" + options.path;
  if (options.expires instanceof Date) cookie += "; Expires=" + options.expires.toUTCString();
  if (options.httpOnly) cookie += "; HttpOnly";
  if (options.secure) cookie += "; Secure";
  if (options.sameSite) {
    const sameSite = options.sameSite === true ? "Strict" : String(options.sameSite);
    cookie += "; SameSite=" + sameSite[0].toUpperCase() + sameSite.slice(1).toLowerCase();
  }
  return cookie;
}

function createResponseAdapter(): {
  response: Response;
  ready: Promise<globalThis.Response>;
  isCommitted: () => boolean;
  fail: (error: unknown) => void;
} {
  const events = new EventEmitter();
  const headers = new Headers();
  let statusCode = 200;
  let committed = false;
  let stream: PassThrough | null = null;
  let resolveReady!: (response: globalThis.Response) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<globalThis.Response>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const setHeader = (name: string, value: unknown) => {
    headers.delete(name);
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  };
  const getHeader = (name: string): string | string[] | undefined => {
    const value = headers.get(name);
    if (value === null) return undefined;
    if (name.toLowerCase() === "set-cookie") {
      return (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || value;
    }
    return value;
  };
  const emitFinished = () => queueMicrotask(() => events.emit("finish"));
  const commit = (body: BodyInit | null = null) => {
    if (committed) return;
    if (body !== null && !headers.has("content-length")) {
      const length = typeof body === "string"
        ? Buffer.byteLength(body)
        : body instanceof Uint8Array ? body.byteLength : undefined;
      if (length !== undefined) headers.set("content-length", String(length));
    }
    committed = true;
    resolveReady(new globalThis.Response(body, { status: statusCode, headers }));
    if (!stream) emitFinished();
  };
  const commitStream = () => {
    if (stream) return stream;
    stream = new PassThrough();
    committed = true;
    resolveReady(new globalThis.Response(Readable.toWeb(stream) as unknown as BodyInit, {
      status: statusCode,
      headers,
    }));
    stream.on("finish", () => events.emit("finish"));
    return stream;
  };
  const end = (value?: unknown) => {
    if (stream) {
      if (value !== undefined) {
        stream.end(Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
      } else {
        stream.end();
      }
      return response;
    }
    if (value === undefined) {
      commit();
    } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      commit(Buffer.from(value));
    } else {
      commit(String(value));
    }
    return response;
  };
  const json = (value: unknown) => {
    if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    return end(JSON.stringify(value));
  };
  const send = (value?: unknown) => {
    if (value !== null && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      return json(value);
    }
    return end(value);
  };
  const set = (field: string | Record<string, unknown>, value?: unknown) => {
    if (typeof field === "string") setHeader(field, value);
    else for (const [name, item] of Object.entries(field)) setHeader(name, item);
    return response;
  };
  const type = (value: string) => {
    const contentType = value.includes("/") ? value : ({
      html: "text/html",
      json: "application/json",
      text: "text/plain",
    } as Record<string, string>)[value] || value;
    headers.set("content-type", contentType);
    return response;
  };
  const cookie = (name: string, value: unknown, options?: any) => {
    headers.append("set-cookie", serializeCookie(name, value, options));
    return response;
  };
  const clearCookie = (name: string, options?: any) => cookie(name, "", {
    ...options,
    expires: new Date(1),
    maxAge: 0,
  });
  const redirect = (url: string) => {
    statusCode = 302;
    headers.set("location", url);
    return end();
  };
  const fail = (error: unknown) => {
    if (!committed) rejectReady(error);
    else stream?.destroy(error as Error);
  };
  const sendFile = (filePath: string, optionsOrCallback?: any, callback?: (error?: Error) => void) => {
    const callbackFn = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (!headers.has("content-type")) {
      headers.set("content-type", ({
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".log": "text/plain; charset=utf-8",
        ".png": "image/png",
        ".txt": "text/plain; charset=utf-8",
        ".zip": "application/zip",
      } as Record<string, string>)[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    }
    void fs.promises.open(filePath, "r").then((file) => {
      const fileStream = file.createReadStream();
      fileStream.on("error", (error) => {
        callbackFn?.(error);
        if (!committed) fail(error);
        else stream?.destroy(error);
      });
      fileStream.on("end", () => callbackFn?.());
      fileStream.pipe(commitStream());
    }).catch((error: unknown) => {
      callbackFn?.(error as Error);
      fail(error);
    });
  };
  const download = (filePath: string, filename?: string, callback?: (error?: Error) => void) => {
    const safeFilename = path.basename(filename || path.basename(filePath)).replace(/[\r\n"]/g, "_");
    headers.set("content-disposition", "attachment; filename=\"" + safeFilename + "\"");
    sendFile(filePath, callback);
  };

  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json,
    send,
    cookie,
    clearCookie,
    redirect,
    sendFile,
    download,
    set,
    type,
    setHeader,
    getHeader,
    writeHead(code: number, responseHeaders?: Record<string, unknown>) {
      statusCode = code;
      if (responseHeaders) set(responseHeaders);
      commitStream();
      return response;
    },
    flushHeaders() {
      commitStream();
    },
    write(value: unknown) {
      return commitStream().write(value);
    },
    end,
    destroy(error?: Error) {
      if (!committed) fail(error || new Error("Response destroyed"));
      else stream?.destroy(error);
    },
    on(event: string, listener: (...args: any[]) => void) {
      events.on(event, listener);
      return response;
    },
    once(event: string, listener: (...args: any[]) => void) {
      events.once(event, listener);
      return response;
    },
    removeListener(event: string, listener: (...args: any[]) => void) {
      events.removeListener(event, listener);
      return response;
    },
    emit(event: string, ...args: any[]) {
      return events.emit(event, ...args);
    },
  } as unknown as Response;

  Object.defineProperties(response, {
    statusCode: {
      get: () => statusCode,
      set: (value) => {
        statusCode = Number(value);
      },
    },
    headersSent: { get: () => committed },
    writable: { get: () => !stream || !stream.destroyed },
  });

  return { response, ready, isCommitted: () => committed, fail };
}

function queryObject(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const previous = result[key];
    result[key] = previous === undefined
      ? value
      : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return result;
}

async function createStartRequest(
  request: globalThis.Request,
  url: URL,
  base: string,
  incomingRequest?: IncomingMessage,
): Promise<Request> {
  const headers: Record<string, string | string[] | undefined> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const remoteAddress = request.headers.get("x-panel-remote-address") || undefined;
  const clientIp = request.headers.get("x-panel-client-ip") || remoteAddress;
  const protocol = url.protocol.replace(":", "") || "http";
  const pathname = url.pathname.slice(base.length) || "/";
  const query = queryObject(url);
  if (!headers.authorization && typeof query.token === "string") {
    headers.authorization = "Bearer " + query.token;
  }
  const source = request.body && !request.bodyUsed
    ? Readable.fromWeb(request.body as any)
    : Readable.from([]);
  const runtime = (() => {
    try {
      return getPanelRuntime();
    } catch {
      return {};
    }
  })();
  const startRequest = source as unknown as Request;
  Object.assign(startRequest, {
    method: request.method.toUpperCase(),
    url: pathname + url.search,
    originalUrl: url.pathname + url.search,
    path: pathname,
    headers,
    query,
    params: {},
    protocol,
    secure: protocol === "https",
    ip: clientIp,
    cookies: parseCookies(request.headers.get("cookie") || undefined),
    socket: { remoteAddress, encrypted: protocol === "https" },
    app: {
      get(name: string) {
        if (name === "trust proxy") return request.headers.get("x-panel-trust-proxy") === "1";
        return runtime[name];
      },
    },
    get(name: string) {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value;
    },
  });
  if (incomingRequest?.on) {
    (startRequest as any).on = incomingRequest.on.bind(incomingRequest);
  }
  return startRequest;
}

async function authenticateStartRequest(
  request: globalThis.Request,
  pathname: string,
): Promise<{ user: any } | globalThis.Response | null> {
  if (PUBLIC_API_PATHS.has(pathname) ||
    pathname.startsWith("/api/map/tiles/") ||
    pathname.startsWith("/api/map/toptiles/") ||
    pathname.startsWith("/api/map/b41tiles/") ||
    pathname.startsWith("/api/mods/thumbnail/") ||
    pathname === "/api/debug/client-errors") {
    return null;
  }
  const token = new URL(request.url).searchParams.get("token");
  let runtimeAuthService = authService;
  try {
    runtimeAuthService = getPanelRuntime().authService || authService;
  } catch {
    // The standalone route tests do not boot the panel runtime.
  }
  const result = await runtimeAuthService.authenticateApiRequest(
    request.headers.get("authorization") || (token ? "Bearer " + token : null),
  );
  if (result.ok) return { user: result.user };
  return globalThis.Response.json(
    { error: result.error, code: result.code },
    { status: result.status },
  );
}

function errorResponse(error: unknown): globalThis.Response {
  const details = error && typeof error === "object"
    ? error as { status?: unknown; message?: unknown; code?: unknown }
    : {};
  const status = typeof details.status === "number" ? details.status : 500;
  const message = typeof details.message === "string" ? details.message : String(error);
  const code = isRegisteredErrorCode(details.code)
    ? { code: details.code }
    : {};
  return globalThis.Response.json({
    error: sanitizeError(message),
    ...code,
  }, { status });
}

async function readBodyWithLimit(
  request: globalThis.Request,
  limit: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function handleStartApiRequest(
  request: globalThis.Request,
  incomingRequest?: IncomingMessage,
): Promise<globalThis.Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const module = routeModules.find(({ base }) => pathname === base || pathname.startsWith(base + "/"));
  if (!module) return null;

  const authentication = await authenticateStartRequest(request, pathname);
  if (authentication instanceof globalThis.Response) return authentication;

  const responseAdapter = createResponseAdapter();
  try {
    const contentType = request.headers.get("content-type") || "";
    const length = Number(request.headers.get("content-length") || 0);
    const limit = pathname === "/api/debug/client-errors" ? 16 * 1024 : 1024 * 1024;
    if (length > limit) {
      incomingRequest?.resume();
      return globalThis.Response.json({ error: "Request body is too large" }, { status: 413 });
    }
    let bodyText: string | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" && contentType.includes("json")) {
      const limitedBody = await readBodyWithLimit(request, limit);
      if (limitedBody === null) {
        incomingRequest?.resume();
        return globalThis.Response.json({ error: "Request body is too large" }, { status: 413 });
      }
      bodyText = limitedBody;
    }
    const startRequest = await createStartRequest(
      request,
      url,
      module.base,
      incomingRequest,
    );
    if (bodyText !== undefined) {
      try {
        startRequest.body = bodyText.trim() ? JSON.parse(bodyText) : undefined;
      } catch {
        return globalThis.Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }
    if (authentication && "user" in authentication) startRequest.user = authentication.user;
    const router = await module.load();
    void Promise.resolve(router(startRequest, responseAdapter.response, (error) => {
      if (error) responseAdapter.fail(error);
      else if (!responseAdapter.isCommitted()) {
        responseAdapter.response.status(404).json({ error: "API endpoint not found" });
      }
    })).catch((error: unknown) => {
      if (!responseAdapter.isCommitted()) responseAdapter.fail(error);
      else responseAdapter.response.destroy(error as Error);
    });
    return await responseAdapter.ready;
  } catch (error) {
    return errorResponse(error);
  }
}

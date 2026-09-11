import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export type TanStackStartHandler = {
  fetch(request: Request): Response | Promise<Response>;
};

export async function loadTanStackStartHandler(
  filePath: string,
): Promise<TanStackStartHandler> {
  const module = (typeof process.pkg !== "undefined"
    ? createRequire(import.meta.url)(filePath)
    : await import(pathToFileURL(filePath).href)) as {
    default?: unknown;
  };
  const handler = module.default as Partial<TanStackStartHandler> | undefined;
  if (!handler || typeof handler.fetch !== "function") {
    throw new Error(
      "TanStack Start server bundle has no fetch handler: " + filePath,
    );
  }
  return handler as TanStackStartHandler;
}

type RequestLike = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  socket?: { remoteAddress?: string; encrypted?: boolean };
  ip?: string;
  protocol?: string;
  secure?: boolean;
  app?: { get?: (name: string) => unknown };
  get?: (name: string) => string | undefined;
  on?: (...args: any[]) => unknown;
};

export function toTanStackStartRequest(req: RequestLike): Request {
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, String(item));
    }
  }

  headers.delete("x-panel-remote-address");
  headers.delete("x-panel-client-ip");
  headers.delete("x-panel-trust-proxy");
  if (req.socket?.remoteAddress) {
    headers.set("x-panel-remote-address", req.socket.remoteAddress);
  }
  if (req.ip) headers.set("x-panel-client-ip", req.ip);
  if (req.app?.get?.("trust proxy")) {
    headers.set("x-panel-trust-proxy", "1");
  }

  const protocol = req.protocol || (req.socket?.encrypted ? "https" : "http");
  const host = req.get?.("host") || req.headers.host || "localhost";
  const url = new URL(
    req.originalUrl || req.url || "/",
    protocol + "://" + host,
  );
  const isBodyless = method === "GET" || method === "HEAD";
  const hasParsedBody = Object.prototype.hasOwnProperty.call(req, "body");
  const body = isBodyless || (hasParsedBody && req.body === undefined)
    ? undefined
    : hasParsedBody
      ? Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body)
      : req.on
        ? Readable.toWeb(req as unknown as Readable) as unknown as BodyInit
        : undefined;

  if (body !== undefined) {
    headers.delete("content-length");
    headers.delete("transfer-encoding");
  }

  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body, duplex: "half" as const }),
  });
}

type ResponseLike = Pick<ServerResponse, "setHeader" | "statusCode" | "end">;
export async function sendTanStackStartResponse(
  response: Response,
  res: ResponseLike,
): Promise<void> {
  const setCookies = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();

  response.headers.forEach((value, name) => {
    if (name === "set-cookie" && setCookies?.length) return;
    res.setHeader(name, value);
  });
  if (setCookies?.length) res.setHeader("set-cookie", setCookies);

  res.statusCode = response.status;
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as any),
    res as unknown as NodeJS.WritableStream,
  );
}

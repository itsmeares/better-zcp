import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";

export type TanStackStartHandler = {
  fetch(request: Request): Response | Promise<Response>;
};

export async function loadTanStackStartHandler(
  filePath: string,
): Promise<TanStackStartHandler> {
  const module = (await import(pathToFileURL(filePath).href)) as {
    default?: unknown;
  };
  const handler = module.default as Partial<TanStackStartHandler> | undefined;
  if (!handler || typeof handler.fetch !== "function") {
    throw new Error(`TanStack Start server bundle has no fetch handler: ${filePath}`);
  }
  return handler as TanStackStartHandler;
}

export function toTanStackStartRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }

  const protocol = req.protocol || "http";
  const host = req.get("host") || "localhost";
  const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);

  return new Request(url, {
    method: req.method,
    headers,
  });
}

export async function sendTanStackStartResponse(
  response: Response,
  res: ExpressResponse,
): Promise<void> {
  const setCookies = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();

  response.headers.forEach((value, name) => {
    if (name === "set-cookie" && setCookies?.length) return;
    res.setHeader(name, value);
  });
  if (setCookies?.length) res.setHeader("set-cookie", setCookies);

  res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}

import type { IncomingMessage, ServerResponse } from "node:http";

export type NextFunction = (error?: unknown) => void | Promise<void>;

export type Request = IncomingMessage & {
  body?: any;
  query: Record<string, any>;
  params: Record<string, string>;
  path: string;
  url: string;
  originalUrl?: string;
  protocol?: string;
  secure?: boolean;
  ip?: string;
  user?: any;
  cookies?: Record<string, string | undefined>;
  activeServerContext?: any;
  configEditRestartWarning?: boolean;
  app: { get(name: string): any };
  get(name: string): string | undefined;
};

export type Response = ServerResponse & {
  status(code: number): Response;
  json(value: unknown): Response;
  send(value?: unknown): Response;
  cookie(name: string, value: unknown, options?: any): Response;
  clearCookie(name: string, options?: any): Response;
  redirect(url: string): Response;
  sendFile(filePath: string, options?: Record<string, unknown>, callback?: (error?: Error) => void): void;
  download(filePath: string, filename?: string, callback?: (error?: Error) => void): void;
  set(field: string | Record<string, unknown>, value?: unknown): Response;
  type(value: string): Response;
  writable: boolean;
};

export type RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => unknown;

type RouteLayer = {
  path: string;
  methods: Record<string, boolean>;
  stack: Array<{ handle: RequestHandler }>;
};

export type RouterLayer = {
  handle: RequestHandler;
  route?: RouteLayer;
  name?: string;
};

export type StartApiRouter = RequestHandler & {
  stack: RouterLayer[];
  get(path: string, ...handlers: RequestHandler[]): StartApiRouter;
  post(path: string, ...handlers: RequestHandler[]): StartApiRouter;
  put(path: string, ...handlers: RequestHandler[]): StartApiRouter;
  patch(path: string, ...handlers: RequestHandler[]): StartApiRouter;
  delete(path: string, ...handlers: RequestHandler[]): StartApiRouter;
  all(path: string, ...handlers: RequestHandler[]): StartApiRouter;
  use(...args: Array<string | RequestHandler>): StartApiRouter;
};

function requestPath(request: Request): string {
  if (typeof request.path === "string" && request.path) return request.path;
  const rawUrl = request.url || "/";
  return new URL(rawUrl, "http://panel.invalid").pathname;
}

function splitPath(pathname: string): string[] {
  return pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

function matchPath(
  pattern: string,
  pathname: string,
  prefix = false,
): Record<string, string> | null {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(pathname);
  if (prefix ? pathParts.length < patternParts.length : pathParts.length !== patternParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

async function runHandlers(
  handlers: RequestHandler[],
  request: Request,
  response: Response,
  done: NextFunction,
): Promise<void> {
  let index = 0;
  const dispatch = async (error?: unknown): Promise<void> => {
    if (error !== undefined) return done(error);
    const handler = handlers[index++];
    if (!handler) return done();

    let nextCalled = false;
    let nextPromise: Promise<void> | undefined;
    const next: NextFunction = (nextError) => {
      if (nextCalled) return nextPromise;
      nextCalled = true;
      nextPromise = dispatch(nextError);
      return nextPromise;
    };
    try {
      await handler(request, response, next);
    } catch (handlerError) {
      return done(handlerError);
    }
    if (nextPromise) await nextPromise;
  };

  await dispatch();
}

function createRouter(): StartApiRouter {
  const stack: RouterLayer[] = [];
  const router = (async (
    request: Request,
    response: Response,
    outerNext: NextFunction,
  ) => {
    const pathname = requestPath(request);
    const method = String(request.method || "GET").toLowerCase();
    let index = 0;

    const dispatch = async (error?: unknown): Promise<void> => {
      if (error !== undefined) {
        await outerNext(error);
        return;
      }
      const layer = stack[index++];
      if (!layer) {
        await outerNext();
        return;
      }
      if (layer.route) {
        const methodMatches = layer.route.methods[method] ||
          (method === "head" && layer.route.methods.get);
        if (!methodMatches) return dispatch();
        const params = matchPath(layer.route.path, pathname);
        if (!params) return dispatch();
        const previousParams = request.params;
        request.params = { ...previousParams, ...params };
        await runHandlers(
          layer.route.stack.map((entry) => entry.handle),
          request,
          response,
          dispatch,
        );
        request.params = previousParams;
        return;
      }

      const usePath = (layer as RouterLayer & { path?: string }).path;
      const params = usePath ? matchPath(usePath, pathname, true) : {};
      if (params === null) return dispatch();
      const previousParams = request.params;
      request.params = { ...previousParams, ...params };
      let nextPromise: Promise<void> | undefined;
      const next: NextFunction = (nextError) => {
        nextPromise = dispatch(nextError);
        return nextPromise;
      };
      await layer.handle(request, response, next);
      if (nextPromise) await nextPromise;
      request.params = previousParams;
    };

    try {
      await dispatch();
    } catch (dispatchError) {
      await outerNext(dispatchError);
    }
  }) as unknown as StartApiRouter;

  const addRoute = (
    method: string,
    path: string,
    handlers: RequestHandler[],
  ): StartApiRouter => {
    stack.push({
      handle: handlers[0] || (async (_request, _response, next) => next()),
      route: {
        path,
        methods: method === "all"
          ? { get: true, post: true, put: true, patch: true, delete: true, options: true, head: true }
          : { [method]: true },
        stack: handlers.map((handle) => ({ handle })),
      },
    });
    return router;
  };

  for (const method of ["get", "post", "put", "patch", "delete", "all"] as const) {
    router[method] = ((path: string, ...handlers: RequestHandler[]) =>
      addRoute(method, path, handlers)) as StartApiRouter[typeof method];
  }

  router.use = ((...args: Array<string | RequestHandler>) => {
    const path = typeof args[0] === "string" ? String(args.shift()) : undefined;
    for (const handler of args) {
      if (typeof handler !== "function") continue;
      const layer = { handle: handler, name: handler.name || "anonymous" } as RouterLayer & { path?: string };
      if (path) layer.path = path;
      stack.push(layer);
    }
    return router;
  }) as StartApiRouter["use"];

  router.stack = stack;
  return router;
}

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  message?: unknown;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
};

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (request, response, next) => {
    const key = request.ip || request.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (options.standardHeaders) {
      response.setHeader("RateLimit-Limit", String(options.max));
      response.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
      response.setHeader("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));
    }
    if (bucket.count > options.max) {
      response.status(429).json(options.message ?? { error: "Too many requests" });
      return;
    }
    return next();
  };
}

export { createRouter as Router };

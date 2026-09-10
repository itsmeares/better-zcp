import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import fs from "node:fs";
import path from "node:path";
import {
  appendCspScriptHashes,
  computeInlineScriptCspHashesFromHtml,
} from "../utils/cspScriptHash.ts";
import {
  loadTanStackStartHandler,
  sendTanStackStartResponse,
  toTanStackStartRequest,
  type TanStackStartHandler,
} from "../utils/tanstackStartServer.ts";
import {
  clientDistMatchesMetadata,
  readClientDistMetadata,
} from "../utils/embeddedClient.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeError } from "../utils/sanitize.ts";

type AnyRecord = Record<string, any>;
const REGISTERED_ERROR_CODES = new Set<string>(Object.values(ErrorCode));

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

export type PanelWebOptions = {
  isPackaged: boolean;
  clientDistPath: string;
  externalClientDistPath: string;
  embeddedClientDistPath: string | null;
  buildMetadata: BuildMetadata;
  logger: PanelWebLogger;
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

function createTanStackStartPageSender(
  options: PanelWebOptions,
  getHandler: () => Promise<TanStackStartHandler | null>,
): (req: Request, res: Response) => Promise<boolean> {
  return async (req, res) => {
    try {
      const handler = await getHandler();
      if (!handler) return false;

      const response = await handler.fetch(toTanStackStartRequest(req));
      if (response.headers.get("content-type")?.includes("text/html")) {
        const hashes = computeInlineScriptCspHashesFromHtml(
          await response.clone().text(),
        );
        const cspHeader = res.getHeader("Content-Security-Policy");
        if (typeof cspHeader === "string") {
          res.setHeader(
            "Content-Security-Policy",
            appendCspScriptHashes(cspHeader, hashes),
          );
        }
      }

      await sendTanStackStartResponse(response, res);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn(
        `TanStack Start page render failed (${message}); using the static client shell`,
      );
      return false;
    }
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

export function sendClientIndex(
  res: Response,
  clientDistPath: string,
  callback?: (error?: Error) => void,
) {
  return res.sendFile("index.html", { root: clientDistPath }, callback);
}

export function apiErrorHandler(
  logger: PanelWebLogger,
  err: AnyRecord,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error(`Unhandled API error on ${req.method} ${req.path}: ${err.message}`);
  const status = err.status || 500;
  const body: AnyRecord = { error: sanitizeError(err.message) };
  if (typeof err.code === "string" && REGISTERED_ERROR_CODES.has(err.code)) {
    body.code = err.code;
  }
  res.status(status).json(body);
}

export function registerTanStackStartApiRoute(
  app: Express,
  options: PanelWebOptions,
  routePath: string,
): void {
  const getHandler = createTanStackStartHandlerLoader(options);

  app.get(routePath, (req, res, next) => {
    void (async () => {
      const handler = await getHandler();
      if (!handler) return next();

      const response = await handler.fetch(toTanStackStartRequest(req));
      const contentType = response.headers.get("content-type") || "";
      if (response.status === 404 || contentType.includes("text/html")) {
        return next();
      }

      await sendTanStackStartResponse(response, res);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn(
        `TanStack Start API route failed for ${routePath} (${message}); using Express fallback`,
      );
      if (!res.headersSent) next();
    });
  });
}

export function registerPanelWebRoutes(
  app: Express,
  options: PanelWebOptions,
): void {
  const legacyClientMetadata =
    options.isPackaged && !options.embeddedClientDistPath
      ? readClientDistMetadata(options.clientDistPath)
      : null;
  const legacyClientMismatch =
    options.isPackaged &&
    !options.embeddedClientDistPath &&
    !clientDistMatchesMetadata(options.clientDistPath, options.buildMetadata);

  if (legacyClientMismatch) {
    options.logger.error(
      `Packaged frontend does not match executable ${options.buildMetadata.panelVersion}/${options.buildMetadata.buildSha}; serving recovery page instead of mixed client/dist`,
    );
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) return next();
      res
        .status(503)
        .type("html")
        .send(buildLegacyClientRecoveryPage(options, legacyClientMetadata));
    });
  }

  options.logger.debug(`Serving client from: ${options.clientDistPath}`);
  if (!legacyClientMismatch) {
    app.use(
      express.static(options.clientDistPath, {
        maxAge: "7d",
        immutable: true,
        setHeaders(res, filePath) {
          if (filePath.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
  }

  const getHandler = createTanStackStartHandlerLoader(options);
  const sendTanStackStartPage = createTanStackStartPageSender(options, getHandler);

  app.use((req, res, next) => {
    if (!req.path.startsWith("/_serverFn/")) return next();

    void sendTanStackStartPage(req, res).then((handled) => {
      if (handled || res.headersSent) return;
      res.status(503).json({ error: "TanStack Start server functions unavailable" });
    }).catch(next);
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "API endpoint not found" });
      return;
    }

    void sendTanStackStartPage(req, res).then((handled) => {
      if (handled || res.headersSent) return;
      sendClientIndex(res, options.clientDistPath, (err) => {
        if (err) {
          options.logger.error(`Failed to serve index.html: ${err.message}`);
          res.status(500).send("Page not available");
        }
      });
    });
  });
}

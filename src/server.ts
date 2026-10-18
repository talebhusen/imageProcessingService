import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { MemoryCache, type CachedImage } from "./cache/memoryCache.js";
import { loadConfig, type Config } from "./config.js";
import { ClientAbortedError, HttpError } from "./errors.js";
import { clientAddress, handleProcess } from "./handleProcess.js";
import { RateLimiter } from "./limit/rateLimit.js";
import { WorkGate } from "./limit/workGate.js";
import { serveStatic } from "./static.js";

export type ProcessLog = {
  msg: "process";
  status: number;
  ms: number;
  cache?: string;
  host?: string;
  code?: string;
};

export type Logger = (event: ProcessLog) => void;

const defaultLogger: Logger = (event) => {
  console.log(JSON.stringify(event));
};

export function createApp(config: Config = loadConfig(), logger: Logger = defaultLogger): Server {
  const cache = new MemoryCache<CachedImage>(
    config.cacheMaxEntries,
    config.cacheTtlMs,
    Date.now,
    config.cacheMaxBytes,
    (image) => image.bytes.length,
  );
  const limiter = new RateLimiter(config.rateLimitPerMinute, 60_000);
  const gate = new WorkGate(config.inflightLimit);

  return createServer(async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on("close", onClose);
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/process") {
        const host = hostFromParams(url.searchParams);
        try {
          const image = await handleProcess(
            url.searchParams,
            clientAddress(req, config.trustProxy),
            config,
            cache,
            limiter,
            gate,
            controller.signal,
          );
          if (controller.signal.aborted || res.writableEnded) return;
          const status = ifNoneMatch(req.headers["if-none-match"], image.headers.ETag) ? 304 : 200;
          logger({
            msg: "process",
            status,
            ms: Date.now() - started,
            cache: image.headers["X-Cache"],
            host,
          });
          writeImage(req, res, image);
          return;
        } catch (error) {
          logger({
            msg: "process",
            status: statusOf(error),
            ms: Date.now() - started,
            host,
            code: codeOf(error),
          });
          throw error;
        }
      }
      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(res, url.pathname, req.method);
        return;
      }
      throw new HttpError(404, "not_found", `no route for ${req.method ?? "GET"} ${url.pathname}`);
    } catch (error) {
      sendError(res, error);
    } finally {
      req.off("close", onClose);
    }
  });
}

function writeImage(req: IncomingMessage, res: ServerResponse, image: CachedImage): void {
  if (ifNoneMatch(req.headers["if-none-match"], image.headers.ETag)) {
    res.writeHead(304, {
      ETag: image.headers.ETag,
      "Cache-Control": image.headers["Cache-Control"],
      "X-Cache": image.headers["X-Cache"],
      "X-Image-Width": image.headers["X-Image-Width"],
      "X-Image-Height": image.headers["X-Image-Height"],
      "X-Image-Format": image.headers["X-Image-Format"],
    });
    res.end();
    return;
  }
  res.writeHead(200, image.headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(image.bytes);
}

function ifNoneMatch(header: string | string[] | undefined, etag: string | undefined): boolean {
  if (!etag) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;
  if (raw.trim() === "*") return true;
  return raw
    .split(",")
    .map((value) => value.trim().replace(/^W\//i, ""))
    .includes(etag);
}

function hostFromParams(params: URLSearchParams): string | undefined {
  const raw = params.get("url");
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ClientAbortedError) return 499;
  return 500;
}

function codeOf(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof ClientAbortedError) return "client_closed";
  return "internal_error";
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ClientAbortedError || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  if (!(error instanceof HttpError)) {
    console.error(error);
  }
  const httpError =
    error instanceof HttpError ? error : new HttpError(500, "internal_error", "something went wrong");
  sendJson(res, httpError.status, httpError.toBody(), httpError.headers);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const config = loadConfig();
  if (config.allowPrivateUrls) {
    console.warn("ALLOW_PRIVATE_URLS is enabled; loopback fetches are allowed");
  }
  const server = createApp(config);
  server.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(config.port, () => {
    console.log(`listening on http://localhost:${config.port}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

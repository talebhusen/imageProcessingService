import http from "node:http";
import https from "node:https";
import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP } from "node:net";
import type { Config } from "../config.js";
import { ClientAbortedError, HttpError } from "../errors.js";
import { isBlockedAddress, isLoopbackAddress } from "./blockedAddress.js";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const blockedHostnames = new Set(["metadata.google.internal"]);

export type FetchedSource = {
  bytes: Buffer;
  contentType: string;
};

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export async function safeFetch(
  rawUrl: string,
  config: Config,
  resolve: Resolver = dnsResolve,
  signal?: AbortSignal,
): Promise<FetchedSource> {
  let current = prepareFetchUrl(rawUrl, config);
  let redirects = 0;
  const deadline = Date.now() + config.fetchTimeoutMs;
  const timeLeft = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new HttpError(504, "upstream_timeout", "upstream request timed out");
    return left;
  };

  while (true) {
    throwIfAborted(signal);
    const response = await requestOnce(current, timeLeft(), config, resolve, signal).catch((error: unknown) => {
      throw mapTransportError(error);
    });

    if (redirectStatuses.has(response.status)) {
      discard(response.stream);
      redirects += 1;
      if (redirects > config.maxRedirects) {
        throw new HttpError(400, "too_many_redirects", `stopped after ${config.maxRedirects} redirects`);
      }
      const location = singleHeader(response.headers.location);
      if (!location) {
        throw new HttpError(502, "upstream_fetch_failed", "redirect was missing a location");
      }
      current = prepareFetchUrl(new URL(location, current).href, config);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      discard(response.stream);
      throw new HttpError(502, "upstream_fetch_failed", `upstream responded with status ${response.status}`);
    }

    const declaredLength = contentLength(response.headers["content-length"]);
    if (declaredLength !== undefined && declaredLength > config.maxSourceBytes) {
      discard(response.stream);
      throw new HttpError(413, "source_too_large", `source exceeds ${config.maxSourceBytes} bytes`);
    }

    let bodyTimeoutMs: number;
    try {
      bodyTimeoutMs = timeLeft();
    } catch (error) {
      discard(response.stream);
      throw error;
    }
    const bytes = await readLimited(response.stream, config.maxSourceBytes, bodyTimeoutMs, signal).catch(
      (error: unknown) => {
        throw mapTransportError(error);
      },
    );
    const contentType = singleHeader(response.headers["content-type"]) ?? "application/octet-stream";
    return { bytes, contentType };
  }
}

export function prepareFetchUrl(raw: string, config: Config): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_url", "url must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "invalid_url", "url must use http or https");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "invalid_url", "url must not include credentials");
  }

  const hostname = bareHostname(url.hostname.toLowerCase());
  if (blockedHostnames.has(hostname) || isBlockedHost(hostname, config)) {
    throw new HttpError(400, "blocked_url", "url resolves to a blocked address");
  }
  return url;
}

function bareHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isBlockedHost(hostname: string, config: Config): boolean {
  if (hostname === "localhost") {
    return !config.allowPrivateUrls;
  }
  if (isIP(hostname) === 0) return false;
  return isBlockedForFetch(hostname, config);
}

export function isBlockedForFetch(address: string, config: Config): boolean {
  if (!isBlockedAddress(address)) return false;
  return !(config.allowPrivateUrls && isLoopbackAddress(address));
}

function dnsResolve(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

type UpstreamResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
};

function requestOnce(
  url: URL,
  timeoutMs: number,
  config: Config,
  resolve: Resolver,
  signal?: AbortSignal,
): Promise<UpstreamResponse> {
  throwIfAborted(signal);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolveResponse, reject) => {
    let timer: NodeJS.Timeout;
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "ours-image-service",
          accept: "image/*,*/*;q=0.8",
        },
        lookup: createLookup(config, resolve),
      },
      (stream) => {
        cleanup();
        resolveResponse({
          status: stream.statusCode ?? 0,
          headers: stream.headers,
          stream,
        });
      },
    );
    const onAbort = () => {
      request.destroy(new ClientAbortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      request.destroy(Object.assign(new Error("upstream timed out"), { code: "TIMEOUT" }));
    }, timeoutMs);
    request.on("error", (error) => {
      cleanup();
      reject(error);
    });
    request.end();
  });
}

function createLookup(config: Config, resolve: Resolver) {
  return (
    hostname: string,
    options: LookupOptions | ((error: NodeJS.ErrnoException | null, address: string, family: number) => void),
    callback?: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    const done = typeof options === "function" ? options : callback;
    if (!done) return;
    const host = bareHostname(hostname);
    resolve(host)
      .then((addresses) => {
        if (addresses.length === 0) {
          done(Object.assign(new Error("no addresses"), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (addresses.some((entry) => isBlockedForFetch(entry.address, config))) {
          done(Object.assign(new Error("blocked address"), { code: "BLOCKED_ADDRESS" }), "", 0);
          return;
        }
        const wantsAll = typeof options !== "function" && options.all === true;
        if (wantsAll) {
          const reportAll = done as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: LookupAddress[],
          ) => void;
          reportAll(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          done(Object.assign(new Error("no addresses"), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        done(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error("lookup failed");
        done(wrapped as NodeJS.ErrnoException, "", 0);
      });
  };
}

function readLimited(
  stream: http.IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(Object.assign(new Error("upstream timed out"), { code: "TIMEOUT" }));
    }, timeoutMs);
    const onAbort = () => finish(new ClientAbortedError());
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        stream.destroy();
        reject(error);
        return;
      }
      resolve(value ?? Buffer.alloc(0));
    };

    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(new HttpError(413, "source_too_large", `source exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => finish(undefined, Buffer.concat(chunks)));
    stream.on("error", (error) => finish(asError(mapTransportError(error))));
  });
}

function discard(stream: http.IncomingMessage): void {
  stream.on("error", () => {});
  stream.destroy();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClientAbortedError();
}

function mapTransportError(error: unknown): HttpError | ClientAbortedError {
  if (error instanceof ClientAbortedError || error instanceof HttpError) return error;
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "BLOCKED_ADDRESS") {
    return new HttpError(400, "blocked_url", "url resolves to a blocked address");
  }
  if (code === "TIMEOUT") {
    return new HttpError(504, "upstream_timeout", "upstream request timed out");
  }
  return new HttpError(502, "upstream_fetch_failed", "could not fetch the url");
}

function asError(error: HttpError | ClientAbortedError): Error {
  return error;
}

function contentLength(value: string | string[] | undefined): number | undefined {
  const raw = singleHeader(value);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

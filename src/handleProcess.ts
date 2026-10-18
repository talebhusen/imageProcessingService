import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { MemoryCache, type CachedImage } from "./cache/memoryCache.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { safeFetch } from "./http/safeFetch.js";
import { transformImage } from "./image/transform.js";
import { RateLimiter } from "./limit/rateLimit.js";
import { WorkGate } from "./limit/workGate.js";
import { parseProcessQuery, type ProcessQuery } from "./schema/processQuery.js";

export function cacheKey(query: ProcessQuery, config: Config): string {
  const url = new URL(query.url);
  url.hash = "";
  return JSON.stringify({
    url: url.href,
    width: query.width ?? null,
    height: query.height ?? null,
    format: query.format ?? null,
    quality: query.quality ?? config.defaultQuality,
    crop: query.crop ?? "fit",
  });
}

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const hops = forwarded
        .split(",")
        .map((hop) => hop.trim())
        .filter((hop) => hop !== "");
      const client = hops.at(-1);
      if (client) return client;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function withCache(image: CachedImage, cache: "HIT" | "MISS"): CachedImage {
  return { bytes: image.bytes, headers: { ...image.headers, "X-Cache": cache } };
}

export async function handleProcess(
  searchParams: URLSearchParams,
  clientIp: string,
  config: Config,
  cache: MemoryCache<CachedImage>,
  limiter: RateLimiter,
  gate: WorkGate,
  signal: AbortSignal,
): Promise<CachedImage> {
  const decision = limiter.check(clientIp);
  if (!decision.allowed) {
    throw new HttpError(429, "rate_limited", "too many requests", {
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
    });
  }

  const query = parseProcessQuery(searchParams, config.maxEdgePx);
  const key = cacheKey(query, config);
  const cached = cache.get(key);
  if (cached) return withCache(cached, "HIT");

  const outcome = await gate.run(key, signal, async (flightSignal) => {
    const source = await safeFetch(query.url, config, undefined, flightSignal);
    const image = await transformImage(source.bytes, query, config, flightSignal);
    const etag = createHash("sha256").update(image.bytes).digest("hex");
    const stored: CachedImage = {
      bytes: image.bytes,
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(image.bytes.length),
        ETag: `"${etag}"`,
        "Cache-Control": `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
        "X-Image-Width": String(image.width),
        "X-Image-Height": String(image.height),
        "X-Image-Format": image.format,
      },
    };
    cache.set(key, stored);
    return stored;
  });

  return withCache(outcome.value, outcome.shared ? "HIT" : "MISS");
}

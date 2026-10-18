export type Config = {
  port: number;
  fetchTimeoutMs: number;
  maxSourceBytes: number;
  maxEdgePx: number;
  maxInputPixels: number;
  maxRedirects: number;
  rateLimitPerMinute: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  cacheTtlMs: number;
  inflightLimit: number;
  trustProxy: boolean;
  allowPrivateUrls: boolean;
  defaultQuality: number;
};

function intEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer up to ${max}`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadConfig(): Config {
  return {
    port: intEnv("PORT", 3000, 65_535),
    fetchTimeoutMs: intEnv("FETCH_TIMEOUT_MS", 10_000, 120_000),
    maxSourceBytes: intEnv("MAX_SOURCE_BYTES", 10 * 1024 * 1024, 50 * 1024 * 1024),
    maxEdgePx: intEnv("MAX_EDGE_PX", 2048, 8192),
    maxInputPixels: intEnv("MAX_INPUT_PIXELS", 40_000_000, 100_000_000),
    maxRedirects: intEnv("MAX_REDIRECTS", 3, 10),
    rateLimitPerMinute: intEnv("RATE_LIMIT_PER_MINUTE", 60, 10_000),
    cacheMaxEntries: intEnv("CACHE_MAX_ENTRIES", 100, 10_000),
    cacheMaxBytes: intEnv("CACHE_MAX_BYTES", 64 * 1024 * 1024, 512 * 1024 * 1024),
    cacheTtlMs: intEnv("CACHE_TTL_MS", 5 * 60 * 1000, 24 * 60 * 60 * 1000),
    inflightLimit: intEnv("INFLIGHT_LIMIT", 4, 32),
    trustProxy: boolEnv("TRUST_PROXY", false),
    allowPrivateUrls: boolEnv("ALLOW_PRIVATE_URLS", false),
    defaultQuality: 80,
  };
}

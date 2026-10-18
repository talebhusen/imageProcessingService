import type { Server } from "node:http";
import { once } from "node:events";
import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    fetchTimeoutMs: 1_000,
    maxSourceBytes: 10 * 1024 * 1024,
    maxEdgePx: 2048,
    maxInputPixels: 40_000_000,
    maxRedirects: 3,
    rateLimitPerMinute: 60,
    cacheMaxEntries: 100,
    cacheMaxBytes: 64 * 1024 * 1024,
    cacheTtlMs: 5 * 60 * 1000,
    inflightLimit: 4,
    trustProxy: false,
    allowPrivateUrls: false,
    defaultQuality: 80,
    ...overrides,
  };
}

export async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a tcp address");
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

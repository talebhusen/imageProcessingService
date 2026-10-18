import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { createApp } from "../src/server.js";
import { close, listen, testConfig } from "./helpers.js";

describe("GET /process", { concurrency: false }, () => {
  let fixture: Server;
  let api: Server;
  let fixtureUrl: string;
  let apiUrl: string;
  let hits = 0;
  let mode: "ok" | "missing" | "huge" = "ok";
  const sample = readFile(new URL("./fixtures/sample.png", import.meta.url));

  before(async () => {
    const png = await sample;
    fixture = createServer((req, res) => {
      hits += 1;
      if (mode === "missing") {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      if (mode === "huge") {
        res.writeHead(200, { "Content-Length": String(50_000_000), "Content-Type": "image/png" });
        res.end(png);
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    fixtureUrl = await listen(fixture);
    api = createApp(
      testConfig({
        allowPrivateUrls: true,
        rateLimitPerMinute: 1_000,
        cacheTtlMs: 60_000,
      }),
      () => {},
    );
    apiUrl = await listen(api);
  });

  after(async () => {
    await close(api);
    await close(fixture);
  });

  it("resizes the brief's first example", async () => {
    mode = "ok";
    const response = await fetch(`${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/image.jpg`)}&width=500&height=300`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const info = await sharp(bytes).metadata();
    assert.equal(info.width, 500);
    assert.equal(info.height, 250);
    assert.equal(response.headers.get("content-type"), "image/png");
    assertHeaders(response, 500, 250, "png");
  });

  it("converts format and quality", async () => {
    const response = await fetch(
      `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/image.png`)}&format=jpeg&quality=80`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("x-image-format"), "jpeg");
    const bytes = Buffer.from(await response.arrayBuffer());
    const info = await sharp(bytes).metadata();
    assert.equal(info.format, "jpeg");
    assert.equal(info.width, 200);
    assert.equal(info.height, 100);
  });

  it("fills and encodes webp", async () => {
    const response = await fetch(
      `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/image.jpg`)}&width=800&height=600&format=webp&crop=fill`,
    );
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const info = await sharp(bytes).metadata();
    assert.equal(info.width, 800);
    assert.equal(info.height, 600);
    assert.equal(info.format, "webp");
    assert.equal(response.headers.get("content-type"), "image/webp");
  });

  it("re-encodes an untransformed image at the source size", async () => {
    const response = await fetch(`${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/plain.png`)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-image-width"), "200");
    assert.equal(response.headers.get("x-image-height"), "100");
    assert.equal(response.headers.get("x-cache"), "MISS");
  });

  it("serves a second identical request from cache", async () => {
    hits = 0;
    const url = `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/cached.png`)}&width=40&height=20`;
    const first = await fetch(url);
    assert.equal(first.headers.get("x-cache"), "MISS");
    await first.arrayBuffer();
    const afterFirst = hits;
    const second = await fetch(url);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-cache"), "HIT");
    assert.equal(hits, afterFirst);
    await second.arrayBuffer();
  });

  it("misses the cache when width changes", async () => {
    hits = 0;
    const source = encodeURIComponent(`${fixtureUrl}/vary.png`);
    await (await fetch(`${apiUrl}/process?url=${source}&width=30&height=20`)).arrayBuffer();
    const afterFirst = hits;
    const changed = await fetch(`${apiUrl}/process?url=${source}&width=31&height=20`);
    assert.equal(changed.headers.get("x-cache"), "MISS");
    assert.equal(hits, afterFirst + 1);
    await changed.arrayBuffer();
  });

  it("does not cache an upstream failure", async () => {
    const source = encodeURIComponent(`${fixtureUrl}/flaky.png`);
    mode = "missing";
    const failed = await fetch(`${apiUrl}/process?url=${source}`);
    assert.equal(failed.status, 502);
    const body = await failed.json();
    assert.equal(body.error.code, "upstream_fetch_failed");
    mode = "ok";
    const recovered = await fetch(`${apiUrl}/process?url=${source}`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get("x-cache"), "MISS");
    await recovered.arrayBuffer();
  });

  it("rejects fill without both dimensions before fetching", async () => {
    hits = 0;
    const response = await fetch(
      `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/skip.png`)}&width=10&crop=fill`,
    );
    assert.equal(response.status, 400);
    assert.equal(hits, 0);
    const body = await response.json();
    assert.equal(body.error.param, "height");
    assert.equal(body.error.message, "fill requires both width and height");
  });

  it("reuses the cache for default quality and crop", async () => {
    hits = 0;
    const source = encodeURIComponent(`${fixtureUrl}/defaults.png`);
    const first = await fetch(`${apiUrl}/process?url=${source}&width=20&height=10`);
    assert.equal(first.headers.get("x-cache"), "MISS");
    await first.arrayBuffer();
    const afterFirst = hits;
    const second = await fetch(`${apiUrl}/process?url=${source}&width=20&height=10&quality=80&crop=fit`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-cache"), "HIT");
    assert.equal(hits, afterFirst);
    await second.arrayBuffer();
  });

  it("returns 304 when the etag matches and answers HEAD without a body", async () => {
    const url = `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/etag.png`)}&width=16&height=8`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    await first.arrayBuffer();
    const cached = await fetch(url, { headers: { "if-none-match": etag } });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("etag"), etag);
    assert.equal(cached.headers.get("content-length"), null);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-image-width"), "16");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it("returns 413 when the source declares it is too large", async () => {
    mode = "huge";
    const response = await fetch(
      `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/huge.png`)}`,
    );
    mode = "ok";
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, "source_too_large");
  });
});

describe("rate limit over HTTP", () => {
  it("returns 429 with Retry-After, and a forwarded address is a separate bucket", async () => {
    const png = await readFile(new URL("./fixtures/sample.png", import.meta.url));
    const fixture = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    const fixtureUrl = await listen(fixture);
    const api = createApp(
      testConfig({
        allowPrivateUrls: true,
        trustProxy: true,
        rateLimitPerMinute: 1,
      }),
      () => {},
    );
    const apiUrl = await listen(api);
    try {
      const path = `/process?url=${encodeURIComponent(`${fixtureUrl}/a.png`)}&width=20&height=10`;
      const first = await fetch(`${apiUrl}${path}`, { headers: { "x-forwarded-for": "203.0.113.5" } });
      assert.equal(first.status, 200);
      await first.arrayBuffer();
      const second = await fetch(`${apiUrl}${path}`, { headers: { "x-forwarded-for": "203.0.113.5" } });
      assert.equal(second.status, 429);
      assert.ok(second.headers.get("retry-after"));
      const body = await second.json();
      assert.equal(body.error.code, "rate_limited");
      const other = await fetch(`${apiUrl}${path}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
      assert.equal(other.status, 200);
      await other.arrayBuffer();
      const spoofed = await fetch(`${apiUrl}${path}`, {
        headers: { "x-forwarded-for": "198.51.100.8, 203.0.113.9" },
      });
      assert.equal(spoofed.status, 429);
      await spoofed.json();
    } finally {
      await close(api);
      await close(fixture);
    }
  });
});

describe("concurrent /process", () => {
  it("fetches a shared url once when two requests overlap", async () => {
    const png = await readFile(new URL("./fixtures/sample.png", import.meta.url));
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createServer((_req: IncomingMessage, res: ServerResponse) => {
      calls += 1;
      void gate.then(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
      });
    });
    const fixtureUrl = await listen(fixture);
    const api = createApp(
      testConfig({ allowPrivateUrls: true, inflightLimit: 2, rateLimitPerMinute: 100, fetchTimeoutMs: 2_000 }),
      () => {},
    );
    const apiUrl = await listen(api);
    try {
      const url = `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/same.png`)}&width=12&height=6`;
      const first = fetch(url);
      const second = fetch(url);
      await waitFor(() => calls === 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      release();
      const [left, right] = await Promise.all([first, second]);
      assert.equal(left.status, 200);
      assert.equal(right.status, 200);
      assert.deepEqual([left.headers.get("x-cache"), right.headers.get("x-cache")].sort(), ["HIT", "MISS"]);
      await left.arrayBuffer();
      await right.arrayBuffer();
      assert.equal(calls, 1);
    } finally {
      release();
      await close(api);
      await close(fixture);
    }
  });

  it("returns 429 while the only slot is busy, then accepts work after the client disconnects", async () => {
    const png = await readFile(new URL("./fixtures/sample.png", import.meta.url));
    let calls = 0;
    const fixture = createServer((_req: IncomingMessage, res: ServerResponse) => {
      calls += 1;
      if (calls === 1) return;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    const fixtureUrl = await listen(fixture);
    const api = createApp(
      testConfig({ allowPrivateUrls: true, inflightLimit: 1, rateLimitPerMinute: 100, fetchTimeoutMs: 2_000 }),
      () => {},
    );
    const apiUrl = await listen(api);
    const controller = new AbortController();
    try {
      const blockedUrl = `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/busy.png`)}&width=8&height=4`;
      const nextUrl = `${apiUrl}/process?url=${encodeURIComponent(`${fixtureUrl}/next.png`)}&width=8&height=4`;
      const first = fetch(blockedUrl, { signal: controller.signal });
      await waitFor(() => calls === 1);
      const busy = await fetch(nextUrl);
      assert.equal(busy.status, 429);
      assert.equal((await busy.json()).error.code, "overloaded");
      controller.abort();
      await first.catch(() => undefined);
      await waitFor(async () => {
        const response = await fetch(nextUrl);
        const status = response.status;
        if (status === 200) await response.arrayBuffer();
        else await response.json().catch(() => undefined);
        return status === 200;
      });
    } finally {
      controller.abort();
      await close(api);
      await close(fixture);
    }
  });
});

async function waitFor(ready: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
}

function assertHeaders(response: Response, width: number, height: number, format: string): void {
  assert.equal(response.headers.get("x-image-width"), String(width));
  assert.equal(response.headers.get("x-image-height"), String(height));
  assert.equal(response.headers.get("x-image-format"), format);
  assert.match(response.headers.get("etag") ?? "", /^"[a-f0-9]+"$/);
  assert.match(response.headers.get("cache-control") ?? "", /max-age=/);
  assert.equal(response.headers.get("content-length"), String(Number(response.headers.get("content-length"))));
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryCache } from "../src/cache/memoryCache.js";
import { RateLimiter } from "../src/limit/rateLimit.js";

describe("MemoryCache", () => {
  it("returns a hit until the clock passes the ttl, then drops the oldest entry", () => {
    let now = 1_000;
    const cache = new MemoryCache<string>(2, 500, () => now);
    cache.set("a", "first");
    cache.set("b", "second");
    assert.equal(cache.get("a"), "first");
    cache.set("c", "third");
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("c"), "third");
    now = 1_600;
    assert.equal(cache.get("a"), undefined);
  });

  it("drops the oldest entry when the byte cap is crossed and skips an entry that cannot fit", () => {
    const cache = new MemoryCache<string>(10, 1_000, () => 0, 5, (value) => value.length);
    cache.set("a", "abcd");
    cache.set("b", "ef");
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), "ef");
    cache.set("c", "too-big");
    assert.equal(cache.get("c"), undefined);
    assert.equal(cache.get("b"), "ef");
  });
});

describe("RateLimiter", () => {
  it("allows 60 requests in the window, then rejects with retry-after", () => {
    let now = 0;
    const limiter = new RateLimiter(60, 60_000, () => now);
    for (let i = 0; i < 60; i += 1) {
      assert.equal(limiter.check("10.0.0.1").allowed, true);
    }
    const blocked = limiter.check("10.0.0.1");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 60);
    assert.equal(limiter.check("10.0.0.2").allowed, true);
    now = 60_000;
    assert.equal(limiter.check("10.0.0.1").allowed, true);
  });

  it("forgets an expired address and refuses a new address when the map is full", () => {
    let now = 0;
    const limiter = new RateLimiter(10, 1_000, () => now, 2);
    assert.equal(limiter.check("a").allowed, true);
    now = 1_000;
    assert.equal(limiter.check("b").allowed, true);
    assert.equal(limiter.size(), 1);
    assert.equal(limiter.check("c").allowed, true);
    const blocked = limiter.check("d");
    assert.equal(blocked.allowed, false);
    assert.equal(limiter.check("c").allowed, true);
  });
});

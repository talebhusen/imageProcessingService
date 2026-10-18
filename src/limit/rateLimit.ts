export type RateDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  size(): number {
    return this.buckets.size;
  }

  check(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      if (existing) this.buckets.delete(key);
      if (this.buckets.size >= this.maxKeys) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)),
        };
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number): void {
    if (this.buckets.size <= this.maxKeys && now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

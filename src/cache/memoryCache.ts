type Entry<T> = {
  value: T;
  expiresAt: number;
  size: number;
};

export type CachedImage = {
  bytes: Buffer;
  headers: Record<string, string>;
};

export class MemoryCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: T) => number = () => 0,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.purgeExpired();
    if (this.entries.has(key)) this.remove(key);
    const size = Math.max(0, this.sizeOf(value));
    if (size > this.maxBytes) return;
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, size });
    this.total += size;
    while (this.entries.size > this.maxEntries || this.total > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.remove(oldest);
    }
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.total -= entry.size;
    this.entries.delete(key);
  }
}

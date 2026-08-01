interface RateWindow {
  startedAt: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class InvoiceShareRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private operations = 0;

  constructor(
    private readonly maxRequests = 60,
    private readonly windowMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new Error("maxRequests must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive integer");
    }
  }

  check(key: string): RateLimitResult {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      this.pruneOccasionally(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    current.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + this.windowMs - now) / 1000));
    this.pruneOccasionally(now);
    return { allowed: current.count <= this.maxRequests, retryAfterSeconds };
  }

  private pruneOccasionally(now: number): void {
    this.operations += 1;
    if (this.operations % 256 !== 0) return;
    for (const [key, value] of this.windows) {
      if (now - value.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}

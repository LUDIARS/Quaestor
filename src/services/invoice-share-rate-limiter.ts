/** @implements SPEC-INVOICE-ACCESS-002 (spec/feature/invoice-public-magic-link.md) */
interface RateWindow {
  startedAt: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * 追跡する client address の上限。 CF-Connecting-IP / X-Forwarded-For は詐称できるので、
 * ヘッダを振り替え続ける相手にプロセスメモリを伸ばされないよう頭打ちにする。
 */
const MAX_TRACKED_KEYS = 10_000;

export class InvoiceShareRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private operations = 0;

  constructor(
    private readonly maxRequests = 60,
    private readonly windowMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly maxTrackedKeys = MAX_TRACKED_KEYS,
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new Error("maxRequests must be a positive integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive integer");
    }
    if (!Number.isSafeInteger(maxTrackedKeys) || maxTrackedKeys <= 0) {
      throw new Error("maxTrackedKeys must be a positive integer");
    }
  }

  check(key: string): RateLimitResult {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      // Map の更新は既存キーの順序を動かさない。期限切れの窓を先に消してから
      // 入れ直し、退避対象が本当に最古の生存キーになるようにする。
      if (current) this.windows.delete(key);
      this.makeRoom(now);
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
    this.prune(now);
  }

  private prune(now: number): void {
    for (const [key, value] of this.windows) {
      if (now - value.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }

  /** 新規キーを入れる前に上限を守る。 期限切れを掃き、 それでも埋まっていれば最古を捨てる。 */
  private makeRoom(now: number): void {
    if (this.windows.size < this.maxTrackedKeys) return;
    this.prune(now);
    while (this.windows.size >= this.maxTrackedKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
  }
}

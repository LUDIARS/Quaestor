import type { MailSource } from "@ludiars/mail-inbox";
import type { MailMessagesRepo } from "../db/mail-messages-repo.js";
import type { MailCrawlStateRepo } from "../db/mail-crawl-state-repo.js";
import type { MailIdSource } from "./gmail-crawl-source.js";
import { GmailRateLimit } from "./gmail-rate-limit.js";

interface CrawlerDeps {
  source: MailSource & MailIdSource; messages: MailMessagesRepo; state: MailCrawlStateRepo;
  query: string; ready: () => boolean; process: (id: string) => Promise<boolean>; now?: () => number;
}

/** @implements SPEC-MAIL-CRAWLER-001 SPEC-MAIL-CRAWLER-002 SPEC-MAIL-CRAWLER-003 */
export class MailCrawler {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private readonly now: () => number;
  constructor(private readonly deps: CrawlerDeps) { this.now = deps.now ?? Date.now; }
  status() {
    const state = this.deps.state.load(this.deps.query);
    return { ready: this.deps.ready(), running: !!this.running, pending: state.pending.length,
      nextAt: state.nextAt, processed: state.processed, lastError: state.lastError, pageSize: 10,
      backfill: state.backfill ?? null };
  }
  /** @implements SPEC-MAIL-CRAWLER-004 */
  startBackfill(requestId: string, limit: number): ReturnType<MailCrawler["status"]> {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("invalid_backfill_request");
    }
    const state = this.deps.state.load(this.deps.query);
    if (state.backfill?.requestId === requestId) {
      if (state.backfill.target !== limit) throw new Error("backfill_request_conflict");
      return this.status();
    }
    if (this.running || state.backfill?.status === "active") throw new Error("crawler_busy");
    state.backfill = { requestId, target: limit, processed: 0, status: "active" };
    // Keep pending work and provider cooldown; restart discovery at the newest page.
    state.pageToken = null; state.endOfScan = false;
    this.deps.state.save(state);
    return this.status();
  }
  start(): void { this.stopped = false; this.schedule(); }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running; }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private schedule(): void {
    if (this.stopped) return;
    const nextAt = this.deps.state.load(this.deps.query).nextAt;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule()).catch(() => { this.stopped = true; });
    }, Math.min(2_147_000_000, Math.max(1000, nextAt - this.now())));
    this.timer.unref();
  }
  private async run(): Promise<void> {
    const state = this.deps.state.load(this.deps.query);
    if (this.stopped || this.now() < state.nextAt) return;
    const started = this.now();
    state.nextAt = started + 60_000;
    if (!this.deps.ready()) { this.deps.state.save(state); return; }
    try {
      while (!this.stopped && this.now() - started < 60_000) {
        const backfill = state.backfill?.status === "active" ? state.backfill : undefined;
        if (backfill && (backfill.processed >= backfill.target || (state.endOfScan && !state.pending.length))) {
          backfill.status = backfill.processed >= backfill.target ? "completed" : "exhausted";
          state.pending = []; state.pageToken = null; state.endOfScan = false;
          break;
        }
        if (!state.pending.length) {
          if (state.endOfScan) { state.endOfScan = false; state.pageToken = null; break; }
          const page = await this.deps.source.listIds(state.query, state.pageToken);
          if (page.nextPageToken && page.nextPageToken === state.pageToken) throw new Error("gmail_repeated_page");
          // Snapshot pending IDs before fetching bodies so partial success survives errors/restarts.
          for (const id of page.ids) {
            const existing = this.deps.messages.find(id);
            if (backfill && existing) continue;
            if (existing && existing.outcome !== "error" && existing.outcome !== "processing") {
              state.endOfScan = true; break;
            }
            if (!existing && !state.pending.includes(id)) state.pending.push(id);
          }
          state.pageToken = page.nextPageToken;
          if (!page.nextPageToken) state.endOfScan = true;
          this.deps.state.save(state);
          if (!state.pending.length) continue;
        }
        const id = state.pending[0]!;
        if (!this.deps.messages.find(id) && await this.deps.process(id)) {
          state.processed++;
          if (backfill) backfill.processed++;
        }
        state.pending.shift();
        state.failures = 0; state.lastError = null;
        this.deps.state.save(state);
      }
    } catch (error) {
      state.failures++;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      state.lastError = error instanceof GmailRateLimit ? `gmail_${error.status}_${error.reason}`
        : /^(?:mail_analysis_unconfigured|mail_luna_[a-z0-9_]+)$/.test(code) ? code : "mail_crawl_failed";
      const backoff = Math.min(60_000 * 2 ** Math.min(state.failures - 1, 6), 3_600_000);
      state.nextAt = Math.max(this.now() + backoff, error instanceof GmailRateLimit ? error.retryAt : 0);
    }
    this.deps.state.save(state);
  }
}

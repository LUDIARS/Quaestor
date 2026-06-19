/**
 * 補助金の定期クロールワーカー (#278)。
 *
 * 設定済みキーワードで SubsidyCrawler を定期実行し、新規補助金を DB に取込む。
 * 同時に期限切れ (deadline < 今日) の open 補助金を自動 closed にする。
 *
 * OcrWorker / NotificationWorker と同じ setInterval パターン。
 */

import type { SubsidyCrawler } from "./subsidy-crawler.js";
import type { SubsidiesRepo } from "../db/subsidies-repo.js";
import type { Logger } from "pino";

export interface SubsidyCrawlWorkerOptions {
  crawler: SubsidyCrawler;
  repo: SubsidiesRepo;
  /** クロール対象キーワード一覧。各キーワードを順番に検索する */
  keywords: string[];
  /** 1 キーワードあたりの取込上限件数。既定 10 */
  perKeywordLimit?: number;
  intervalMs: number;
  logger?: Logger;
}

export class SubsidyCrawlWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: SubsidyCrawlWorkerOptions) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    const log = this.opts.logger;
    const today = new Date().toISOString().slice(0, 10);

    // 1. 期限切れを自動 close
    const closed = this.opts.repo.closeExpiredBefore(today);
    if (closed > 0) log?.info({ closed }, "subsidy-crawl: expired subsidies closed");

    // 2. 各キーワードをクロールして新規取込
    const limit = this.opts.perKeywordLimit ?? 10;
    let imported = 0;
    let skipped = 0;
    for (const kw of this.opts.keywords) {
      if (this.stopped) break;
      let found: Awaited<ReturnType<SubsidyCrawler["search"]>>;
      try {
        found = await this.opts.crawler.search(kw, { limit });
      } catch (e) {
        log?.warn({ kw, err: (e as Error).message }, "subsidy-crawl: search failed");
        continue;
      }
      for (const cand of found) {
        const existing = this.opts.repo.findByAnyExternalId(cand.external_id);
        if (existing) { skipped++; continue; }
        try {
          this.opts.repo.insert(cand);
          imported++;
        } catch (e) {
          log?.warn({ kw, name: cand.name, err: (e as Error).message }, "subsidy-crawl: insert failed");
        }
      }
    }

    if (imported > 0 || skipped > 0) {
      log?.info({ imported, skipped }, "subsidy-crawl: tick done");
    }
  }
}

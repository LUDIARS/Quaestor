import type Database from "better-sqlite3";

export interface MailCrawlState {
  query: string; pageToken: string | null; pending: string[]; endOfScan: boolean;
  nextAt: number; failures: number; processed: number; lastError: string | null;
  backfill?: { requestId: string; target: number; processed: number; status: "active" | "completed" | "exhausted" };
}

/** @implements SPEC-MAIL-CRAWLER-003 */
export class MailCrawlStateRepo {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS mail_crawl_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
  }
  load(query: string): MailCrawlState {
    const row = this.db.prepare("SELECT value FROM mail_crawl_state WHERE id=1").get() as { value: string } | undefined;
    const state = row ? JSON.parse(row.value) as MailCrawlState : null;
    if (state?.query === query) return state;
    return { query, pageToken: null, pending: [], endOfScan: false, nextAt: 0, failures: 0, processed: 0, lastError: null };
  }
  save(state: MailCrawlState): void {
    this.db.prepare("INSERT INTO mail_crawl_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(state));
  }
}

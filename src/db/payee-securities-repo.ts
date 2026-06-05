/**
 * payee_securities — 店名(正規化) → 銘柄リンクの repo。
 * 行動解析の payee と市場データ (securities/quotes/perks) を橋渡しする。
 */

import type Database from "better-sqlite3";

export type SecurityRelation = "operator" | "brand" | "parent" | "none";
export type MappingSource = "claude" | "manual";

export interface PayeeSecurityRow {
  id: number;
  payee_norm: string;
  payee_sample: string | null;
  ticker: string | null;
  relation: SecurityRelation;
  confidence: number;
  reason: string | null;
  source: MappingSource;
  created_at: number;
  updated_at: number;
}

export interface UpsertMappingInput {
  payee_norm: string;
  payee_sample?: string | null;
  ticker?: string | null;
  relation: SecurityRelation;
  confidence?: number;
  reason?: string | null;
  source?: MappingSource;
}

export class PayeeSecuritiesRepo {
  constructor(private readonly db: Database.Database) {}

  /** payee_norm を一意キーに upsert。 */
  upsert(input: UpsertMappingInput): void {
    const now = nowSec();
    this.db
      .prepare(
        `INSERT INTO payee_securities
           (payee_norm, payee_sample, ticker, relation, confidence, reason, source, created_at, updated_at)
         VALUES (@payee_norm, @payee_sample, @ticker, @relation, @confidence, @reason, @source, @now, @now)
         ON CONFLICT(payee_norm) DO UPDATE SET
           payee_sample = excluded.payee_sample,
           ticker = excluded.ticker,
           relation = excluded.relation,
           confidence = excluded.confidence,
           reason = excluded.reason,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run({
        payee_norm: input.payee_norm,
        payee_sample: input.payee_sample ?? null,
        ticker: input.ticker ?? null,
        relation: input.relation,
        confidence: input.confidence ?? 0,
        reason: input.reason ?? null,
        source: input.source ?? "claude",
        now,
      });
  }

  find(payeeNorm: string): PayeeSecurityRow | undefined {
    return this.db
      .prepare(`SELECT * FROM payee_securities WHERE payee_norm = ?`)
      .get(payeeNorm) as PayeeSecurityRow | undefined;
  }

  /** 既にマッピング解析済 (上場 or 該当なし問わず) の payee_norm 集合。 */
  mappedKeys(): Set<string> {
    const rows = this.db.prepare(`SELECT payee_norm FROM payee_securities`).all() as {
      payee_norm: string;
    }[];
    return new Set(rows.map((r) => r.payee_norm));
  }

  list(): PayeeSecurityRow[] {
    return this.db
      .prepare(`SELECT * FROM payee_securities ORDER BY confidence DESC, payee_norm ASC`)
      .all() as PayeeSecurityRow[];
  }

  /** ticker が確定している (上場該当あり) リンクのみ。 */
  listLinked(): PayeeSecurityRow[] {
    return this.db
      .prepare(`SELECT * FROM payee_securities WHERE ticker IS NOT NULL ORDER BY confidence DESC`)
      .all() as PayeeSecurityRow[];
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

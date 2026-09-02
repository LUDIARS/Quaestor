import type Database from "better-sqlite3";

export type ObservationSource = "journal-xlsx" | "ledger";

export interface ApportionmentObservationRow {
  id: number;
  fiscal_year: number;
  payee_norm: string;
  payee_sample: string;
  rate: number;
  code: number;
  occurrences: number;
  total_amount: number;
  first_seen: string | null;
  last_seen: string | null;
  source: ObservationSource;
  updated_at: number;
}

export interface ObservationInput {
  fiscal_year: number;
  payee_norm: string;
  payee_sample: string;
  rate: number;
  code: number;
  amount: number;
  date: string | null;
  source: ObservationSource;
}

/**
 * 按分観測の集計テーブル。 再構築前提なので source 単位で消して足す。
 * @implements SPEC-APPORTIONMENT-SHEET-001 (spec/feature/household-bookkeeping.md)
 */
export class ApportionmentObservationsRepo {
  constructor(private readonly db: Database.Database) {}

  clearSource(source: ObservationSource, fiscalYears?: readonly number[]): number {
    if (!fiscalYears) {
      return this.db.prepare(`DELETE FROM apportionment_observations WHERE source = ?`).run(source).changes;
    }
    if (fiscalYears.length === 0) return 0;
    const placeholders = fiscalYears.map(() => "?").join(", ");
    return this.db
      .prepare(`DELETE FROM apportionment_observations WHERE source = ? AND fiscal_year IN (${placeholders})`)
      .run(source, ...fiscalYears).changes;
  }

  /** 1 観測を加算 (同じ payee/rate/code/source なら occurrences と total を増やす)。 */
  add(input: ObservationInput): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO apportionment_observations
           (fiscal_year, payee_norm, payee_sample, rate, code, occurrences, total_amount, first_seen, last_seen, source, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(fiscal_year, payee_norm, rate, code, source) DO UPDATE SET
           occurrences = occurrences + 1,
           total_amount = total_amount + excluded.total_amount,
           first_seen = CASE WHEN first_seen IS NULL OR (excluded.first_seen IS NOT NULL AND excluded.first_seen < first_seen)
                             THEN excluded.first_seen ELSE first_seen END,
           last_seen = CASE WHEN last_seen IS NULL OR (excluded.last_seen IS NOT NULL AND excluded.last_seen > last_seen)
                            THEN excluded.last_seen ELSE last_seen END,
           updated_at = excluded.updated_at`,
      )
      .run(input.fiscal_year, input.payee_norm, input.payee_sample, input.rate, input.code, input.amount, input.date, input.date, input.source, now);
  }

  addMany(inputs: ObservationInput[]): number {
    let n = 0;
    this.db.transaction(() => { for (const i of inputs) { this.add(i); n++; } })();
    return n;
  }

  list(): ApportionmentObservationRow[] {
    return this.db
      .prepare(`SELECT * FROM apportionment_observations ORDER BY payee_norm ASC, occurrences DESC, id ASC`)
      .all() as ApportionmentObservationRow[];
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM apportionment_observations`).get() as { c: number }).c;
  }
}

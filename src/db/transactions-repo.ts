import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ImportedTransaction, SourceKind, TransactionRow } from "../shared/types.js";

export interface InsertTransactionInput extends ImportedTransaction {
  source: SourceKind;
  import_id?: number | null;
}

export interface BulkResult {
  inserted: number;
  duplicates: number;   // unique 制約に当たって弾かれた件数
  inserted_ids: string[];
}

export interface ListFilter {
  source?: SourceKind;
  account?: string;
  date_from?: string;   // ISO yyyy-mm-dd 含む
  date_to?: string;     // ISO yyyy-mm-dd 含む
  payee_like?: string;  // payee LIKE %x%
  limit?: number;
  offset?: number;
}

export class TransactionsRepo {
  constructor(private readonly db: Database.Database) {}

  insertOne(input: InsertTransactionInput): string | null {
    const now = nowSec();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO transactions
           (id, date, amount_in, amount_out, currency, fx_amount, fx_currency,
            description, payee, source, source_id, account, import_id, metadata,
            is_transfer, created_at, updated_at)
           VALUES (@id,@date,@amount_in,@amount_out,@currency,@fx_amount,@fx_currency,
                   @description,@payee,@source,@source_id,@account,@import_id,@metadata,
                   @is_transfer,@created_at,@updated_at)`,
        )
        .run({
          id,
          date: input.date,
          amount_in: input.amount_in,
          amount_out: input.amount_out,
          currency: input.currency,
          fx_amount: input.fx_amount,
          fx_currency: input.fx_currency,
          description: input.description,
          payee: input.payee,
          source: input.source,
          source_id: input.source_id,
          account: input.account,
          import_id: input.import_id ?? null,
          metadata: JSON.stringify(input.metadata),
          is_transfer: input.is_transfer ? 1 : 0,
          created_at: now,
          updated_at: now,
        });
      return id;
    } catch (e: unknown) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return null;
      throw e;
    }
  }

  /** 一括 insert。 unique 制約違反は静かに skip して duplicates にカウント */
  insertBulk(inputs: InsertTransactionInput[]): BulkResult {
    const insertedIds: string[] = [];
    let duplicates = 0;
    this.db.transaction(() => {
      for (const row of inputs) {
        const id = this.insertOne(row);
        if (id) insertedIds.push(id);
        else duplicates++;
      }
    })();
    return { inserted: insertedIds.length, duplicates, inserted_ids: insertedIds };
  }

  find(id: string): TransactionRow | undefined {
    return this.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as
      | TransactionRow
      | undefined;
  }

  list(filter: ListFilter = {}): TransactionRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.source) { where.push("source = @source"); params.source = filter.source; }
    if (filter.account) { where.push("account = @account"); params.account = filter.account; }
    if (filter.date_from) { where.push("date >= @date_from"); params.date_from = filter.date_from; }
    if (filter.date_to) { where.push("date <= @date_to"); params.date_to = filter.date_to; }
    if (filter.payee_like) { where.push("payee LIKE @payee_like"); params.payee_like = `%${filter.payee_like}%`; }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    return this.db
      .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY date DESC, created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as TransactionRow[];
  }

  count(filter: ListFilter = {}): number {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.source) { where.push("source = @source"); params.source = filter.source; }
    if (filter.account) { where.push("account = @account"); params.account = filter.account; }
    if (filter.date_from) { where.push("date >= @date_from"); params.date_from = filter.date_from; }
    if (filter.date_to) { where.push("date <= @date_to"); params.date_to = filter.date_to; }
    if (filter.payee_like) { where.push("payee LIKE @payee_like"); params.payee_like = `%${filter.payee_like}%`; }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM transactions ${whereSql}`).get(params) as { c: number };
    return r.c;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

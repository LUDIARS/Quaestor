import type Database from "better-sqlite3";

export type JournalOrigin = "transaction" | "manual" | "imported";
export type JournalLeg = "expense" | "household" | "income";

export interface JournalEntryRow {
  id: number;
  fiscal_year: number;
  entry_date: string;
  no: number;
  debit_code: number;
  debit_amount: number;
  credit_code: number;
  credit_amount: number;
  description: string;
  payment: number;
  rate: number;
  origin: JournalOrigin;
  leg: JournalLeg | null;
  source_tx_id: string | null;
  receipt_id: string | null;
  household_category_id: number | null;
  locked: number;
  created_at: number;
  updated_at: number;
}

export interface CreateJournalEntryInput {
  fiscal_year: number;
  entry_date: string;
  debit_code: number;
  debit_amount: number;
  credit_code: number;
  credit_amount: number;
  description: string;
  payment: number;
  rate: number;
  origin: JournalOrigin;
  leg?: JournalLeg | null;
  source_tx_id?: string | null;
  receipt_id?: string | null;
  household_category_id?: number | null;
  locked?: boolean;
  no?: number;
}

export interface UpdateJournalEntryInput {
  entry_date?: string;
  debit_code?: number;
  debit_amount?: number;
  credit_code?: number;
  credit_amount?: number;
  description?: string;
  payment?: number;
  rate?: number;
  household_category_id?: number | null;
  locked?: boolean;
}

export interface JournalListFilter {
  month?: number;          // 1..12
  code?: number;           // 借方または貸方にこの科目を含む
  origin?: JournalOrigin;
  household_category_id?: number;
}

/**
 * journal_entries の CRUD と年度単位の入れ替え・採番。 集計は services/bookkeeping 側。
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-001 (spec/feature/household-bookkeeping.md)
 */
export class JournalEntriesRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateJournalEntryInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO journal_entries
           (fiscal_year, entry_date, no, debit_code, debit_amount, credit_code, credit_amount, description,
            payment, rate, origin, leg, source_tx_id, receipt_id, household_category_id, locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fiscal_year, input.entry_date, input.no ?? 0,
        input.debit_code, input.debit_amount, input.credit_code, input.credit_amount, input.description,
        input.payment, input.rate, input.origin, input.leg ?? null, input.source_tx_id ?? null,
        input.receipt_id ?? null, input.household_category_id ?? null, input.locked ? 1 : 0, now, now,
      );
    return Number(r.lastInsertRowid);
  }

  insertMany(inputs: CreateJournalEntryInput[]): number[] {
    const ids: number[] = [];
    this.db.transaction(() => { for (const input of inputs) ids.push(this.insert(input)); })();
    return ids;
  }

  find(id: number): JournalEntryRow | undefined {
    return this.db.prepare(`SELECT * FROM journal_entries WHERE id = ?`).get(id) as JournalEntryRow | undefined;
  }

  listYear(fiscalYear: number, filter: JournalListFilter = {}): JournalEntryRow[] {
    const where = ["fiscal_year = ?"];
    const params: unknown[] = [fiscalYear];
    if (filter.month !== undefined) {
      where.push("CAST(substr(entry_date, 6, 2) AS INTEGER) = ?");
      params.push(filter.month);
    }
    if (filter.code !== undefined) {
      where.push("(debit_code = ? OR credit_code = ?)");
      params.push(filter.code, filter.code);
    }
    if (filter.origin) { where.push("origin = ?"); params.push(filter.origin); }
    if (filter.household_category_id !== undefined) {
      where.push("household_category_id = ?");
      params.push(filter.household_category_id);
    }
    return this.db
      .prepare(`SELECT * FROM journal_entries WHERE ${where.join(" AND ")} ORDER BY entry_date ASC, no ASC, id ASC`)
      .all(...params) as JournalEntryRow[];
  }

  years(): number[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT fiscal_year AS y FROM journal_entries ORDER BY y DESC`)
      .all() as { y: number }[];
    return rows.map((r) => r.y);
  }

  update(id: number, input: UpdateJournalEntryInput): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown) => { sets.push(`${col} = ?`); params.push(v); };
    if (input.entry_date !== undefined) push("entry_date", input.entry_date);
    if (input.debit_code !== undefined) push("debit_code", input.debit_code);
    if (input.debit_amount !== undefined) push("debit_amount", input.debit_amount);
    if (input.credit_code !== undefined) push("credit_code", input.credit_code);
    if (input.credit_amount !== undefined) push("credit_amount", input.credit_amount);
    if (input.description !== undefined) push("description", input.description);
    if (input.payment !== undefined) push("payment", input.payment);
    if (input.rate !== undefined) push("rate", input.rate);
    if (input.household_category_id !== undefined) push("household_category_id", input.household_category_id);
    if (input.locked !== undefined) push("locked", input.locked ? 1 : 0);
    if (sets.length === 0) return this.find(id) !== undefined;
    push("updated_at", Math.floor(Date.now() / 1000));
    params.push(id);
    const r = this.db.prepare(`UPDATE journal_entries SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM journal_entries WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /** 自動生成行 (origin=transaction, locked=0) を年度単位で削除。 戻り値は削除件数。 */
  deleteGenerated(fiscalYear: number): number {
    const r = this.db
      .prepare(`DELETE FROM journal_entries WHERE fiscal_year = ? AND origin = 'transaction' AND locked = 0`)
      .run(fiscalYear);
    return r.changes;
  }

  /** origin=imported を年度単位で削除 (xlsx 再取込用)。 */
  deleteImported(fiscalYear: number): number {
    const r = this.db
      .prepare(`DELETE FROM journal_entries WHERE fiscal_year = ? AND origin = 'imported'`)
      .run(fiscalYear);
    return r.changes;
  }

  /** locked な自動生成行の source_tx_id と leg を返す (rebuild で再生成しないため)。 */
  lockedGeneratedKeys(fiscalYear: number): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT source_tx_id, leg FROM journal_entries
         WHERE fiscal_year = ? AND origin = 'transaction' AND locked = 1 AND source_tx_id IS NOT NULL`,
      )
      .all(fiscalYear) as { source_tx_id: string; leg: string | null }[];
    return new Set(rows.map((r) => `${r.source_tx_id}|${r.leg ?? ""}`));
  }

  /** 年度内を (entry_date, id) 順に 1 から採番し直す。 */
  renumber(fiscalYear: number): number {
    const rows = this.db
      .prepare(`SELECT id FROM journal_entries WHERE fiscal_year = ? ORDER BY entry_date ASC, id ASC`)
      .all(fiscalYear) as { id: number }[];
    const stmt = this.db.prepare(`UPDATE journal_entries SET no = ? WHERE id = ?`);
    this.db.transaction(() => {
      rows.forEach((r, i) => stmt.run(i + 1, r.id));
    })();
    return rows.length;
  }
}

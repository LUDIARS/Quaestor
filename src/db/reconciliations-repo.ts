import type Database from "better-sqlite3";

export interface ReconciliationRow {
  id: number;
  receipt_id: string;
  transaction_id: string;
  matched_by: "auto" | "manual";
  confidence: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateInput {
  receipt_id: string;
  transaction_id: string;
  matched_by: "auto" | "manual";
  confidence: number;
  notes?: string | null;
}

export class ReconciliationsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInput): number | null {
    const now = Math.floor(Date.now() / 1000);
    try {
      const r = this.db
        .prepare(
          `INSERT INTO reconciliations
           (receipt_id, transaction_id, matched_by, confidence, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.receipt_id,
          input.transaction_id,
          input.matched_by,
          input.confidence,
          input.notes ?? null,
          now,
          now,
        );
      return Number(r.lastInsertRowid);
    } catch (e: unknown) {
      if (e instanceof Error && /UNIQUE/.test(e.message)) return null;
      throw e;
    }
  }

  find(id: number): ReconciliationRow | undefined {
    return this.db.prepare(`SELECT * FROM reconciliations WHERE id = ?`).get(id) as
      | ReconciliationRow
      | undefined;
  }

  list(): ReconciliationRow[] {
    return this.db
      .prepare(`SELECT * FROM reconciliations ORDER BY created_at DESC`)
      .all() as ReconciliationRow[];
  }

  byReceipt(receiptId: string): ReconciliationRow[] {
    return this.db
      .prepare(`SELECT * FROM reconciliations WHERE receipt_id = ?`)
      .all(receiptId) as ReconciliationRow[];
  }

  byTransaction(transactionId: string): ReconciliationRow[] {
    return this.db
      .prepare(`SELECT * FROM reconciliations WHERE transaction_id = ?`)
      .all(transactionId) as ReconciliationRow[];
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM reconciliations WHERE id = ?`).run(id);
    return r.changes > 0;
  }
}

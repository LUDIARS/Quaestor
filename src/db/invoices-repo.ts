import type Database from "better-sqlite3";

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface InvoiceRow {
  id: number;
  issued_at: string;
  due_date: string | null;
  client: string;
  work_summary: string;
  amount: number;
  withholding_tax: number;
  status: InvoiceStatus;
  transaction_id: string | null;
  notes: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateInvoiceInput {
  issued_at: string;
  due_date?: string | null;
  client: string;
  work_summary: string;
  amount: number;
  withholding_tax?: number;
  status?: InvoiceStatus;
  transaction_id?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListFilter {
  status?: InvoiceStatus;
  client?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export class InvoicesRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateInvoiceInput): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO invoices
         (issued_at, due_date, client, work_summary, amount, withholding_tax, status,
          transaction_id, notes, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.issued_at,
        input.due_date ?? null,
        input.client,
        input.work_summary,
        input.amount,
        input.withholding_tax ?? 0,
        input.status ?? "sent",
        input.transaction_id ?? null,
        input.notes ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      );
    return Number(r.lastInsertRowid);
  }

  find(id: number): InvoiceRow | undefined {
    return this.db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as InvoiceRow | undefined;
  }

  list(filter: ListFilter = {}): InvoiceRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) { where.push("status = @status"); params.status = filter.status; }
    if (filter.client) { where.push("client = @client"); params.client = filter.client; }
    if (filter.date_from) { where.push("issued_at >= @date_from"); params.date_from = filter.date_from; }
    if (filter.date_to) { where.push("issued_at <= @date_to"); params.date_to = filter.date_to; }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    return this.db
      .prepare(`SELECT * FROM invoices ${whereSql} ORDER BY issued_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as InvoiceRow[];
  }

  update(id: number, patch: Partial<CreateInvoiceInput>): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const map: Record<string, unknown> = patch as Record<string, unknown>;
    for (const k of [
      "issued_at", "due_date", "client", "work_summary", "amount",
      "withholding_tax", "status", "transaction_id", "notes",
    ]) {
      if (k in map) { sets.push(`${k} = @${k}`); params[k] = map[k]; }
    }
    if ("metadata" in map) {
      sets.push("metadata = @metadata");
      params.metadata = patch.metadata ? JSON.stringify(patch.metadata) : null;
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = @updated_at");
    params.updated_at = Math.floor(Date.now() / 1000);
    const r = this.db.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM invoices WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /** status 集計 (dashboard 用) */
  summary(): Record<InvoiceStatus, { count: number; amount: number; withholding: number }> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount,
                COALESCE(SUM(withholding_tax),0) AS withholding
         FROM invoices GROUP BY status`,
      )
      .all() as { status: InvoiceStatus; count: number; amount: number; withholding: number }[];
    const out = {
      draft: { count: 0, amount: 0, withholding: 0 },
      sent: { count: 0, amount: 0, withholding: 0 },
      paid: { count: 0, amount: 0, withholding: 0 },
      overdue: { count: 0, amount: 0, withholding: 0 },
      cancelled: { count: 0, amount: 0, withholding: 0 },
    } satisfies Record<InvoiceStatus, { count: number; amount: number; withholding: number }>;
    for (const r of rows) out[r.status] = { count: r.count, amount: r.amount, withholding: r.withholding };
    return out;
  }
}

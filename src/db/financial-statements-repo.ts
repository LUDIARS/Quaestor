import type Database from "better-sqlite3";

export type FsSection =
  | "pl"            // 損益計算書 (収益 / 経費 / 所得)
  | "bs_assets"     // 貸借対照表 資産の部
  | "bs_liabilities" // 貸借対照表 負債・資本の部
  | "monthly_sales" // 月別売上 (発生主義)
  | "deduction"     // 控除 (医療費 / 国民年金 / 社保 等)
  | "summary";      // 家計サマリ (収入 / 税金 / 生活費 / 投資 / 貯蓄)

export type FsSource = "manual" | "imported" | "computed";

export interface FsRow {
  id: number;
  year: number;
  section: FsSection;
  label: string;
  amount: number | null;
  display_order: number;
  metadata: string | null;
  source: FsSource;
  created_at: number;
  updated_at: number;
}

export interface UpsertInput {
  year: number;
  section: FsSection;
  label: string;
  amount: number | null;
  display_order?: number;
  metadata?: Record<string, unknown> | null;
  source?: FsSource;
}

export class FinancialStatementsRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: UpsertInput): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO financial_statements
         (year, section, label, amount, display_order, metadata, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(year, section, label) DO UPDATE SET
           amount = excluded.amount,
           display_order = excluded.display_order,
           metadata = excluded.metadata,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.year,
        input.section,
        input.label,
        input.amount,
        input.display_order ?? 0,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.source ?? "manual",
        now,
        now,
      );
  }

  findYear(year: number): FsRow[] {
    return this.db
      .prepare(`SELECT * FROM financial_statements WHERE year = ? ORDER BY section, display_order, id`)
      .all(year) as FsRow[];
  }

  years(): number[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT year FROM financial_statements ORDER BY year DESC`)
      .all() as { year: number }[];
    return rows.map((r) => r.year);
  }

  /**
   * Year + section ごとに既存 row を全削除 (再 import 用)。
   */
  clearSection(year: number, section: FsSection): number {
    const r = this.db
      .prepare(`DELETE FROM financial_statements WHERE year = ? AND section = ?`)
      .run(year, section);
    return r.changes;
  }

  /**
   * 指定 year に対し transactions / invoices から P&L / 月別売上 / 簡易 summary を計算して
   * source='computed' として upsert する。 imported (xlsx) と区別。
   *
   * 使い分け: imported が無い年度は computed の値を表示する。
   */
  computeFromTransactions(year: number): { plRows: number; monthlyRows: number; summaryRows: number } {
    const dateFrom = `${year}-01-01`;
    const dateTo = `${year}-12-31`;

    // P&L: 売上 = invoices status in (sent, paid) の amount 合計
    const sales = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM invoices WHERE issued_at >= ? AND issued_at <= ? AND status != 'cancelled'`)
      .get(dateFrom, dateTo) as { s: number };
    const expenses = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_out), 0) AS s FROM transactions
         WHERE date >= ? AND date <= ? AND is_transfer = 0`,
      )
      .get(dateFrom, dateTo) as { s: number };
    const profit = sales.s - expenses.s;

    this.clearSection(year, "pl");
    this.upsert({ year, section: "pl", label: "売上 (収入) 金額", amount: sales.s, display_order: 1, source: "computed" });
    this.upsert({ year, section: "pl", label: "経費合計", amount: expenses.s, display_order: 2, source: "computed" });
    this.upsert({ year, section: "pl", label: "所得金額 (差引)", amount: profit, display_order: 3, source: "computed" });

    // 月別売上 (invoice issued_at ベース、 発生主義)
    const monthly = this.db
      .prepare(
        `SELECT substr(issued_at, 1, 7) AS month, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
         FROM invoices
         WHERE issued_at >= ? AND issued_at <= ? AND status != 'cancelled'
         GROUP BY month ORDER BY month`,
      )
      .all(dateFrom, dateTo) as { month: string; amount: number; count: number }[];

    this.clearSection(year, "monthly_sales");
    let monthlyOrder = 0;
    for (const m of monthly) {
      this.upsert({
        year,
        section: "monthly_sales",
        label: m.month,
        amount: m.amount,
        display_order: ++monthlyOrder,
        metadata: { count: m.count },
        source: "computed",
      });
    }

    // 家計サマリ (簡易)
    this.clearSection(year, "summary");
    const inSum = this.db
      .prepare(`SELECT COALESCE(SUM(amount_in), 0) AS s FROM transactions WHERE date >= ? AND date <= ? AND is_transfer = 0`)
      .get(dateFrom, dateTo) as { s: number };
    const outSum = this.db
      .prepare(`SELECT COALESCE(SUM(amount_out), 0) AS s FROM transactions WHERE date >= ? AND date <= ? AND is_transfer = 0`)
      .get(dateFrom, dateTo) as { s: number };
    this.upsert({ year, section: "summary", label: "総入金 (cash basis)", amount: inSum.s, display_order: 1, source: "computed" });
    this.upsert({ year, section: "summary", label: "総出金 (cash basis)", amount: outSum.s, display_order: 2, source: "computed" });
    this.upsert({ year, section: "summary", label: "差引 (純貯蓄相当)", amount: inSum.s - outSum.s, display_order: 3, source: "computed" });

    return { plRows: 3, monthlyRows: monthly.length, summaryRows: 3 };
  }
}

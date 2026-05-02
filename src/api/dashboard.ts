/**
 * Personal dashboard 用の集計エンドポイント。
 *
 * GET /v1/dashboard/summary?from=YYYY-MM&to=YYYY-MM
 *   月別の入金 / 出金合計、 source 別内訳、 上位 payee。
 */

import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  top_payees: z.coerce.number().int().min(1).max(50).optional(),
});

export function dashboardRouter(deps: { db: Database.Database }): Hono {
  const app = new Hono();

  // GET /v1/dashboard/years — transactions / receipts / invoices に存在する年一覧
  app.get("/years", (c) => {
    const rows = deps.db
      .prepare(
        `SELECT DISTINCT substr(date, 1, 4) AS year FROM (
            SELECT date FROM transactions WHERE date IS NOT NULL
            UNION ALL
            SELECT date FROM receipts WHERE date IS NOT NULL
            UNION ALL
            SELECT issued_at AS date FROM invoices
         )
         ORDER BY year DESC`,
      )
      .all() as { year: string }[];
    return c.json({ years: rows.map((r) => r.year).filter((y) => /^\d{4}$/.test(y)) });
  });

  app.get("/summary", (c) => {
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const from = parsed.data.from ?? defaultFromMonth();
    const to = parsed.data.to ?? currentMonth();
    const dateFrom = `${from}-01`;
    const dateTo = `${to}-31`;

    // 月別合計
    const monthly = deps.db
      .prepare(
        `SELECT substr(date, 1, 7) AS month,
                COALESCE(SUM(amount_in), 0) AS amount_in,
                COALESCE(SUM(amount_out), 0) AS amount_out,
                COUNT(*) AS count
         FROM transactions
         WHERE date >= ? AND date <= ? AND is_transfer = 0
         GROUP BY month
         ORDER BY month ASC`,
      )
      .all(dateFrom, dateTo) as { month: string; amount_in: number; amount_out: number; count: number }[];

    // source 別内訳 (期間全体)
    const bySource = deps.db
      .prepare(
        `SELECT source,
                COALESCE(SUM(amount_in), 0) AS amount_in,
                COALESCE(SUM(amount_out), 0) AS amount_out,
                COUNT(*) AS count
         FROM transactions
         WHERE date >= ? AND date <= ? AND is_transfer = 0
         GROUP BY source
         ORDER BY amount_out DESC`,
      )
      .all(dateFrom, dateTo) as { source: string; amount_in: number; amount_out: number; count: number }[];

    // 上位 payee (出金ベース)
    const topPayees = deps.db
      .prepare(
        `SELECT payee,
                COALESCE(SUM(amount_out), 0) AS total_out,
                COUNT(*) AS count
         FROM transactions
         WHERE date >= ? AND date <= ? AND is_transfer = 0
           AND payee IS NOT NULL AND amount_out IS NOT NULL
         GROUP BY payee
         ORDER BY total_out DESC
         LIMIT ?`,
      )
      .all(dateFrom, dateTo, parsed.data.top_payees ?? 10) as { payee: string; total_out: number; count: number }[];

    // 全期間 grand total
    const grand = deps.db
      .prepare(
        `SELECT COALESCE(SUM(amount_in), 0) AS amount_in,
                COALESCE(SUM(amount_out), 0) AS amount_out,
                COUNT(*) AS count
         FROM transactions
         WHERE date >= ? AND date <= ? AND is_transfer = 0`,
      )
      .get(dateFrom, dateTo) as { amount_in: number; amount_out: number; count: number };

    // 税金 / 社保 内訳: bank tx で description が税金関連 keyword に当たるものを集計
    const taxRows = deps.db
      .prepare(
        `SELECT description AS label, COALESCE(SUM(amount_out), 0) AS amount, COUNT(*) AS count
         FROM transactions
         WHERE date >= ? AND date <= ? AND is_transfer = 0
           AND amount_out IS NOT NULL
           AND (
             description LIKE '%税金%'
             OR description LIKE '%ｺｸｾﾞｲ%'
             OR description LIKE '%ｹﾝﾐﾝ%'
             OR description LIKE '%住民税%'
             OR description LIKE '%所得税%'
             OR description LIKE '%消費税%'
             OR description LIKE '%ｼﾔｶｲﾎｹﾝ%'
             OR description LIKE '%社会保険%'
             OR description LIKE '%国民年金%'
             OR description LIKE '%ｺｸﾐﾝﾈﾝｷﾝ%'
             OR description LIKE '%国民健康保険%'
             OR description LIKE '%ﾎｹﾝﾘﾖｳ%'
             OR description LIKE '%ふるさと%'
             OR description LIKE '%ｱｻｶｾﾞｲﾑｼﾖ%'
             OR description LIKE '%ｾﾞｲﾑｼﾖ%'
           )
         GROUP BY label
         ORDER BY amount DESC`,
      )
      .all(dateFrom, dateTo) as { label: string; amount: number; count: number }[];

    return c.json({
      range: { from, to },
      grand_total: grand,
      monthly,
      by_source: bySource,
      top_payees: topPayees,
      tax_breakdown: taxRows,
    });
  });

  return app;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function defaultFromMonth(): string {
  // デフォルトは過去 12 ヶ月
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 11);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

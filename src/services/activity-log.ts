/**
 * アクティビティログ。 既存テーブルの時刻列から「最近何があったか」を組み立てる (新テーブル無し)。
 *
 * 明細取込 / レシート撮影・投入 / 突合 / 請求書 / 手動仕訳・仕訳取込 / 固定資産 / 按分ルール。
 * 仕訳取込 (origin=imported) は created_at の秒で束ねて 1 件にする。
 *
 * @implements SPEC-MOBILE-HOME-002 (spec/feature/mobile-home.md)
 */

import type Database from "better-sqlite3";

export type ActivityKind =
  | "import" | "receipt_captured" | "receipt_committed" | "reconciliation" | "invoice"
  | "journal_manual" | "journal_imported" | "fixed_asset" | "apportionment_rule";

export interface ActivityEvent {
  kind: ActivityKind;
  /** unix sec */
  at: number;
  title: string;
  detail: string | null;
  /** 遷移先ページ key (web の pages.ts と一致) */
  page: "imports" | "receipts" | "reconcile" | "invoices" | "bookkeeping" | "depreciation" | "apportionment-sheet";
}

const yen = (n: number | null | undefined) => (n == null ? "" : `¥${n.toLocaleString("ja-JP")}`);

export function collectActivity(db: Database.Database, limit = 30): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const take = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 30;

  const imports = db.prepare(
    `SELECT i.id, i.source, i.brand, i.account, i.imported_at,
            (SELECT COUNT(*) FROM transactions t WHERE t.import_id = i.id) AS n
     FROM imports i ORDER BY i.imported_at DESC LIMIT ?`,
  ).all(take) as { source: string; brand: string | null; account: string | null; imported_at: number; n: number }[];
  for (const r of imports) {
    events.push({ kind: "import", at: r.imported_at, title: `明細取込 ${r.brand ?? r.account ?? r.source}`, detail: `${r.n} 件`, page: "imports" });
  }

  const receipts = db.prepare(
    `SELECT payee, total, captured_at, committed_at
     FROM receipts ORDER BY MAX(captured_at, COALESCE(committed_at, captured_at)) DESC LIMIT ?`,
  ).all(take) as { payee: string | null; total: number | null; captured_at: number; committed_at: number | null }[];
  for (const r of receipts) {
    if (r.committed_at !== null) events.push({ kind: "receipt_committed", at: r.committed_at, title: `レシート投入 ${r.payee ?? ""}`.trim(), detail: yen(r.total) || null, page: "receipts" });
    events.push({ kind: "receipt_captured", at: r.captured_at, title: "レシート撮影", detail: r.payee ?? null, page: "receipts" });
  }

  const recon = db.prepare(
    `SELECT rc.matched_by, rc.created_at, r.payee, t.amount_out
     FROM reconciliations rc LEFT JOIN receipts r ON r.id = rc.receipt_id LEFT JOIN transactions t ON t.id = rc.transaction_id
     ORDER BY rc.created_at DESC LIMIT ?`,
  ).all(take) as { matched_by: string; created_at: number; payee: string | null; amount_out: number | null }[];
  for (const r of recon) {
    events.push({ kind: "reconciliation", at: r.created_at, title: `突合 (${r.matched_by === "auto" ? "自動" : "手動"}) ${r.payee ?? ""}`.trim(), detail: yen(r.amount_out) || null, page: "reconcile" });
  }

  const invoices = db.prepare(
    `SELECT client, amount, status, created_at FROM invoices ORDER BY created_at DESC LIMIT ?`,
  ).all(take) as { client: string; amount: number; status: string; created_at: number }[];
  for (const r of invoices) {
    events.push({ kind: "invoice", at: r.created_at, title: `請求書 ${r.client}`, detail: `${yen(r.amount)} (${r.status})`, page: "invoices" });
  }

  const manual = db.prepare(
    `SELECT description, debit_amount, created_at FROM journal_entries WHERE origin = 'manual' ORDER BY created_at DESC LIMIT ?`,
  ).all(take) as { description: string; debit_amount: number; created_at: number }[];
  for (const r of manual) {
    events.push({ kind: "journal_manual", at: r.created_at, title: `仕訳 ${r.description}`, detail: yen(r.debit_amount) || null, page: "bookkeeping" });
  }

  const imported = db.prepare(
    `SELECT created_at, COUNT(*) AS n, MIN(fiscal_year) AS y0, MAX(fiscal_year) AS y1
     FROM journal_entries WHERE origin = 'imported' GROUP BY created_at ORDER BY created_at DESC LIMIT ?`,
  ).all(take) as { created_at: number; n: number; y0: number; y1: number }[];
  for (const r of imported) {
    events.push({ kind: "journal_imported", at: r.created_at, title: "仕訳帳 xlsx 取込", detail: `${r.n} 行 (${r.y0 === r.y1 ? r.y0 : `${r.y0}〜${r.y1}`} 年)`, page: "bookkeeping" });
  }

  const assets = db.prepare(`SELECT name, cost, created_at FROM fixed_assets ORDER BY created_at DESC LIMIT ?`).all(take) as { name: string; cost: number; created_at: number }[];
  for (const r of assets) events.push({ kind: "fixed_asset", at: r.created_at, title: `固定資産 ${r.name}`, detail: yen(r.cost) || null, page: "depreciation" });

  const rules = db.prepare(`SELECT pattern, rate, code, note, created_at FROM apportionment_rules ORDER BY created_at DESC LIMIT ?`).all(take) as { pattern: string; rate: number; code: number; note: string | null; created_at: number }[];
  for (const r of rules) events.push({ kind: "apportionment_rule", at: r.created_at, title: `按分ルール ${r.note ?? r.pattern}`, detail: `${Math.round(r.rate * 100)}% / ${r.code}`, page: "apportionment-sheet" });

  return events.sort((a, b) => b.at - a.at).slice(0, take);
}

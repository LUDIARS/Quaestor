/**
 * 明細行 (date / description / amount) → 取引 (ImportedTransaction) の変換と、 dedupe 鍵の生成。
 *
 * 明細の入口は 2 つある:
 *   - 明細取込ページの「スクショ」 (`smart-import.ts` が Anthropic vision で抽出)
 *   - スキャンで `statement` と分類された画像 (`receipts.kind_fields.rows[]`)
 *
 * どちらも同じ source_id を作るので、 同じ明細を両方から入れても transactions の
 * UNIQUE 制約で 1 件に収束する。 算出規則を 2 つ持たないため、 ここが正本。
 *
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import { createHash } from "node:crypto";
import type { ReceiptRow } from "../db/receipts-repo.js";
import { parseKindFields, type StatementKindFields, type StatementRow } from "../shared/receipt-kind-fields.js";
import { isIsoDate } from "../shared/text.js";
import type { ImportedTransaction } from "../shared/types.js";

/** source_id の材料。 出金 / 入金のどちらか片方が入る。 */
export interface StatementRowKey {
  date: string;
  description: string;
  amount_out?: number | null;
  amount_in?: number | null;
}

/**
 * 明細 1 行の dedupe 鍵。 account + 日付 + 摘要 + 金額 の SHA-1 前半。
 * 値を変えると過去に取り込んだ明細と重複するため、 材料も順序も変えない。
 */
export function statementRowSourceId(account: string, r: StatementRowKey): string {
  const h = createHash("sha1");
  h.update([account, r.date, r.description, r.amount_out ?? "", r.amount_in ?? ""].join("\x1f"));
  return `smart:${h.digest("hex").slice(0, 16)}`;
}

/** 取引にできる行か (日付が ISO で、 金額が 0 でない整数)。 */
function isImportableStatementRow(row: StatementRow): boolean {
  return !!row.date
    && isIsoDate(row.date)
    && row.amount != null
    && Number.isSafeInteger(row.amount)
    && row.amount !== 0;
}

export interface StatementRowsToTransactions {
  account: string;
  /** transactions.metadata に載せる補足 (由来の receipt など) */
  metadata?: Record<string, unknown>;
}

/**
 * `kind_fields.rows[]` を取引へ変換する。 取り込めない行 (日付欠け / 金額欠け) は落とす。
 * 金額は正 = 出金、 負 = 入金として解釈する (`receipt-kind-fields.ts` の符号規則)。
 */
export function statementRowsToTransactions(
  rows: StatementRow[],
  opts: StatementRowsToTransactions,
): ImportedTransaction[] {
  const out: ImportedTransaction[] = [];
  for (const row of rows) {
    if (!isImportableStatementRow(row)) continue;
    const amount = row.amount as number;
    const amountOut = amount > 0 ? amount : null;
    const amountIn = amount < 0 ? -amount : null;
    const description = row.description.trim() || "(摘要なし)";
    out.push({
      date: row.date as string,
      amount_out: amountOut,
      amount_in: amountIn,
      currency: "JPY",
      fx_amount: null,
      fx_currency: null,
      description,
      payee: description,
      source_id: statementRowSourceId(opts.account, {
        date: row.date as string,
        description,
        amount_out: amountOut,
        amount_in: amountIn,
      }),
      account: opts.account,
      metadata: { ...(opts.metadata ?? {}) },
    });
  }
  return out;
}

/** 明細の帰属口座。 OCR の payee (カード名 / 銀行名) を使う。 source_id の材料でもある。 */
const UNKNOWN_STATEMENT_ACCOUNT = "(スキャン明細)";

export function statementAccount(r: Pick<ReceiptRow, "payee">): string {
  return r.payee?.trim() || UNKNOWN_STATEMENT_ACCOUNT;
}

/** `kind_fields.rows[]` のうち取引にできる行。 種別違い / 壊れた JSON なら空配列。 */
export function statementRowsOf(r: Pick<ReceiptRow, "doc_kind" | "kind_fields">): StatementRow[] {
  if (r.doc_kind !== "statement") return [];
  const fields = parseKindFields("statement", r.kind_fields) as StatementKindFields | null;
  return (fields?.rows ?? []).filter(isImportableStatementRow);
}

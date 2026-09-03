/**
 * 書類種別ごとの重複キー。
 *
 *   receipt / handwritten : 日付-場所-金額 (payee は正規化)   … 現行の投入ゲートが使う
 *   invoice               : issuer + invoice_no
 *   utility               : supplier + period_from..period_to
 *   statement / other     : キー無し (明細は source_id 側、 other は投入しない)
 *
 * 投入ゲート (receipt-commit.ts) が使うのは receipt 系だけ。 invoice / utility のキーは
 * 投入先の配線 (次版) で使う前提で、 形だけ先に確定させておく。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 */

import type { ReceiptRow } from "../db/receipts-repo.js";
import { normalizePayee } from "../shared/text.js";
import { invoiceFields, utilityFields } from "../shared/receipt-kind-fields.js";

/** 日付-場所-金額。 いずれか欠けていれば null (完備していない)。 */
export function receiptDuplicateKey(r: Pick<ReceiptRow, "date" | "payee" | "total">): string | null {
  if (!r.date || !r.payee || !r.payee.trim() || r.total == null) return null;
  return `${r.date}|${normalizePayee(r.payee)}|${r.total}`;
}

/** 発行者 + 請求番号。 請求番号が無ければ null (番号無しの請求書は日付-金額で人が見る)。 */
export function invoiceDuplicateKey(r: Pick<ReceiptRow, "doc_kind" | "kind_fields">): string | null {
  const f = invoiceFields(r.doc_kind, r.kind_fields);
  if (!f || !f.issuer || !f.invoice_no) return null;
  return `${normalizePayee(f.issuer)}|${f.invoice_no.trim()}`;
}

/** 供給者 + 使用期間。 期間の両端が無ければ null。 */
export function utilityDuplicateKey(r: Pick<ReceiptRow, "doc_kind" | "kind_fields">): string | null {
  const f = utilityFields(r.doc_kind, r.kind_fields);
  if (!f || !f.supplier || !f.period_from || !f.period_to) return null;
  return `${normalizePayee(f.supplier)}|${f.period_from}..${f.period_to}`;
}

/** 種別に応じたキー。 statement / other は常に null。 */
export function duplicateKeyFor(r: ReceiptRow): string | null {
  switch (r.doc_kind) {
    case "receipt":
    case "handwritten":
      return receiptDuplicateKey(r);
    case "invoice":
      return invoiceDuplicateKey(r);
    case "utility":
      return utilityDuplicateKey(r);
    default:
      return null;
  }
}

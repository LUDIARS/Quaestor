/**
 * 書類種別ごとの重複キー。
 *
 *   receipt / handwritten : 日付-場所-金額 (payee は正規化)
 *   invoice               : issuer + invoice_no (番号が無ければ 日付-場所-金額 に落とす)
 *   utility               : supplier + period_from..period_to (期間が無ければ 日付-場所-金額 に落とす)
 *   statement             : 明細行の source_id 集合 (行そのものの重複は transactions の UNIQUE が弾く)
 *   other                 : キー無し (投入しない)
 *
 * 投入ゲート (`receipt-commit.ts`) は `kindDuplicateKey` を使い、 投入済の同種別レシートと
 * 突き合わせて二重投入を弾く。 キーが作れない (null) 場合は重複判定をしない。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 */

import { createHash } from "node:crypto";
import type { ReceiptRow } from "../db/receipts-repo.js";
import { normalizePayee } from "../shared/text.js";
import { invoiceFields, utilityFields } from "../shared/receipt-kind-fields.js";
import { statementAccount, statementRowSourceId, statementRowsOf } from "./statement-rows.js";

/** 日付-場所-金額。 いずれか欠けていれば null (完備していない)。 */
export function receiptDuplicateKey(r: Pick<ReceiptRow, "date" | "payee" | "total">): string | null {
  if (!r.date || !r.payee || !r.payee.trim() || r.total == null) return null;
  return `${r.date}|${normalizePayee(r.payee)}|${r.total}`;
}

/** 発行者 + 請求番号。 請求番号が無ければ null (番号無しの請求書は日付-金額で人が見る)。 */
export function invoiceDuplicateKey(r: Pick<ReceiptRow, "doc_kind" | "kind_fields">): string | null {
  const f = invoiceFields(r.doc_kind, r.kind_fields);
  if (!f || !f.issuer || !f.invoice_no) return null;
  return `${normalizePayee(f.issuer)}|${normalizePayee(f.invoice_no)}`;
}

/** 供給者 + 使用期間。 期間の両端が無ければ null。 */
export function utilityDuplicateKey(r: Pick<ReceiptRow, "doc_kind" | "kind_fields">): string | null {
  const f = utilityFields(r.doc_kind, r.kind_fields);
  if (!f || !f.supplier || !f.period_from || !f.period_to) return null;
  return `${normalizePayee(f.supplier)}|${f.period_from}..${f.period_to}`;
}

/**
 * 明細行の source_id 集合。 同じ画面を 2 度撮ると同じキーになる。 取り込める行が無ければ null。
 * 行単位の重複は transactions の UNIQUE(source_id) が弾くので、 ここは「同じ明細の再投入」だけを見る。
 */
export function statementDuplicateKey(r: Pick<ReceiptRow, "doc_kind" | "kind_fields" | "payee">): string | null {
  const rows = statementRowsOf(r);
  if (rows.length === 0) return null;
  const account = statementAccount(r);
  const ids = rows
    .map((row) => statementRowSourceId(account, {
      date: row.date as string,
      description: row.description.trim() || "(摘要なし)",
      amount_out: (row.amount as number) > 0 ? row.amount : null,
      amount_in: (row.amount as number) < 0 ? -(row.amount as number) : null,
    }))
    .sort();
  return createHash("sha1").update(ids.join("\n")).digest("hex").slice(0, 16);
}

/**
 * 種別に応じたキー。 invoice / utility は種別固有キーが作れなければ 日付-場所-金額 に落とす
 * (番号や期間が読めなかった紙でも、 同じ日付・発行者・金額の再投入は弾きたい)。 other は常に null。
 */
export function kindDuplicateKey(r: ReceiptRow): string | null {
  switch (r.doc_kind) {
    case "receipt":
    case "handwritten":
      return receiptDuplicateKey(r);
    case "invoice": {
      const issuer = invoiceFields(r.doc_kind, r.kind_fields)?.issuer ?? r.payee;
      return invoiceDuplicateKey(r) ?? receiptDuplicateKey({ ...r, payee: issuer });
    }
    case "utility": {
      const supplier = utilityFields(r.doc_kind, r.kind_fields)?.supplier ?? r.payee;
      return utilityDuplicateKey(r) ?? receiptDuplicateKey({ ...r, payee: supplier });
    }
    case "statement":
      return statementDuplicateKey(r);
    default:
      return null;
  }
}

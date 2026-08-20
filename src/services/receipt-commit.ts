/**
 * レシートの「投入」 (commit) 判定を 1 か所に集約する。
 *
 * 投入の可否は 2 条件だけで決まる:
 *  - 完備:   date / payee / total が揃っている
 *  - 非重複: 投入済の中に同じ (日付-場所-金額) が無い
 *
 * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
 *
 * 手動投入 (POST /v1/receipts/:id/commit) と OCR 完了時の自動投入の双方が
 * この関数を呼ぶ。 判定が 2 箇所に分かれると「手では入るが自動では入らない」
 * ような差異が生まれるため、 分岐は増やさずここへ寄せる。
 */

import type { ReceiptRow, ReceiptsRepo } from "../db/receipts-repo.js";

export type CommitOutcome =
  | { ok: true; already: boolean; receipt: ReceiptRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "incomplete"; missing: string[] }
  | { ok: false; reason: "duplicate"; existingId: string; receipt: ReceiptRow };

/** 投入に必要なフィールドのうち欠けているものを返す (空配列 = 完備)。 */
export function missingCommitFields(r: ReceiptRow): string[] {
  const missing: string[] = [];
  if (!r.date) missing.push("date");
  if (!r.payee || !r.payee.trim()) missing.push("payee");
  if (r.total == null) missing.push("total");
  return missing;
}

/**
 * receipt を投入する。 既に投入済なら冪等に成功を返す。
 * 完備していない / 重複している場合は投入せず理由を返す。
 */
export function commitReceipt(repo: ReceiptsRepo, id: string): CommitOutcome {
  const r = repo.find(id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.committed_at != null) return { ok: true, already: true, receipt: r };

  const missing = missingCommitFields(r);
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing };

  const dup = repo.findCommittedDuplicate(r.date!, r.payee!, r.total!, id);
  if (dup) return { ok: false, reason: "duplicate", existingId: dup.id, receipt: r };

  repo.commit(id);
  return { ok: true, already: false, receipt: repo.find(id) ?? r };
}

/**
 * レシートの「投入」 (commit) 判定を 1 か所に集約する。
 *
 * 投入の可否は書類種別 (doc_kind) の投入方針と、 receipt 系の 2 条件で決まる:
 *  - 種別:   receipt は現行どおり。 handwritten は自動投入せず要確認に残す (手動は可)。
 *            invoice / utility / statement / other は投入先が未配線なので投入しない
 *            (種別を直してから投入する)。
 *  - 完備:   date / payee / total が揃っている
 *  - 非重複: 投入済の中に同じ (日付-場所-金額) が無い
 *
 * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 *
 * 手動投入 (POST /v1/receipts/:id/commit) と OCR 完了時の自動投入の双方が
 * この関数を呼ぶ。 判定が 2 箇所に分かれると「手では入るが自動では入らない」
 * ような差異が生まれるため、 分岐は増やさずここへ寄せる。
 */

import type { ReceiptRow, ReceiptsRepo } from "../db/receipts-repo.js";
import { DOC_KIND_INFO, type DocKind } from "../shared/document-kinds.js";

export type CommitTrigger = "auto" | "manual";

export type CommitOutcome =
  | { ok: true; already: boolean; receipt: ReceiptRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "incomplete"; missing: string[] }
  | { ok: false; reason: "duplicate"; existingId: string; receipt: ReceiptRow }
  /** handwritten: 自動投入しない (人が内容を確かめてから手で投入する) */
  | { ok: false; reason: "needs_review"; kind: DocKind; receipt: ReceiptRow }
  /** invoice / utility / statement / other: 投入先が未配線。 自動・手動とも投入しない */
  | { ok: false; reason: "kind_not_auto_committed"; kind: DocKind; receipt: ReceiptRow };

export interface CommitOptions {
  /** 既定 "manual" (API から)。 OCR 完了時の自動投入は "auto" */
  trigger?: CommitTrigger;
}

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
 * 種別が投入を許さない / 完備していない / 重複している場合は投入せず理由を返す。
 */
export function commitReceipt(repo: ReceiptsRepo, id: string, opts: CommitOptions = {}): CommitOutcome {
  const trigger = opts.trigger ?? "manual";
  const r = repo.find(id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.committed_at != null) return { ok: true, already: true, receipt: r };

  const gate = kindGate(r, trigger);
  if (gate) return gate;

  const missing = missingCommitFields(r);
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing };

  const dup = repo.findCommittedDuplicate(r.date!, r.payee!, r.total!, id);
  if (dup) return { ok: false, reason: "duplicate", existingId: dup.id, receipt: r };

  repo.commit(id);
  return { ok: true, already: false, receipt: repo.find(id) ?? r };
}

/** 種別による投入方針。 通せるなら null。 */
function kindGate(r: ReceiptRow, trigger: CommitTrigger): CommitOutcome | null {
  const policy = DOC_KIND_INFO[r.doc_kind]?.commitPolicy ?? "not_wired";
  switch (policy) {
    case "receipt_rules":
      return null;
    case "manual_only":
      return trigger === "auto"
        ? { ok: false, reason: "needs_review", kind: r.doc_kind, receipt: r }
        : null;
    case "not_wired":
      return { ok: false, reason: "kind_not_auto_committed", kind: r.doc_kind, receipt: r };
  }
}

/**
 * API / ログ向けの理由コード。 種別で弾いた場合は `kind_not_auto_committed:<kind>` の形にする
 * (設計書 §2.2、 要確認一覧で種別ごとに数えられるように)。
 */
export function commitReasonCode(outcome: CommitOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.reason === "kind_not_auto_committed") return `kind_not_auto_committed:${outcome.kind}`;
  return outcome.reason;
}

/** 種別で投入を弾いたときの、 人向けメッセージ。 */
export function kindBlockMessage(kind: DocKind): string {
  const info = DOC_KIND_INFO[kind];
  return `${info.label} は ${info.destination}。 レシートとして投入するなら種別を直してから投入してください`;
}

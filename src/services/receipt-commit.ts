/**
 * レシートの「投入」 (commit) 判定を 1 か所に集約する。
 *
 * 投入の可否は書類種別 (doc_kind) の投入方針と、 種別ごとの 2 条件で決まる:
 *  - 種別:   receipt はそのまま。 handwritten は自動投入せず要確認に残す (手動は可)。
 *            invoice / utility / statement は種別ごとの投入先へ流してから投入する。
 *            other は投入先が無いので投入しない (種別を直してから投入する)。
 *  - 完備:   その投入先が必要とする項目が揃っている (receipt 系は date / payee / total、
 *            invoice は date / total / issuer、 utility は date / total / supplier、 statement は行)
 *  - 非重複: 投入済の同種別に同じ重複キー (`receipt-duplicate-keys.ts`) が無い
 *
 * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-005 (spec/feature/scan-document-kinds.md)
 *
 * 手動投入 (POST /v1/receipts/:id/commit) と OCR 完了時の自動投入の双方が
 * この関数を呼ぶ。 判定が 2 箇所に分かれると「手では入るが自動では入らない」
 * ような差異が生まれるため、 分岐は増やさずここへ寄せる。 種別ごとの投入先そのものは
 * `receipt-kind-destinations.ts` にあり、 ここは「いつ流すか」だけを持つ。
 */

import type { ReceiptRow, ReceiptsRepo } from "../db/receipts-repo.js";
import { DOC_KIND_INFO, type DocKind } from "../shared/document-kinds.js";
import { kindDuplicateKey } from "./receipt-duplicate-keys.js";
import {
  RECEIPTS_ONLY_DESTINATIONS,
  type KindDestinations,
} from "./receipt-kind-destinations.js";

export type CommitTrigger = "auto" | "manual";

/** 投入先へ流した結果 (受領書類 id / cost_rule id / 取込件数 など)。 */
export interface CommitDelivery {
  kind: DocKind;
  detail: Record<string, unknown>;
}

export type CommitOutcome =
  | { ok: true; already: boolean; receipt: ReceiptRow; delivery?: CommitDelivery }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "incomplete"; missing: string[] }
  | { ok: false; reason: "duplicate"; existingId: string; receipt: ReceiptRow }
  /** handwritten: 自動投入しない (人が内容を確かめてから手で投入する) */
  | { ok: false; reason: "needs_review"; kind: DocKind; receipt: ReceiptRow }
  /** other: 投入先が無い。 自動・手動とも投入しない */
  | { ok: false; reason: "kind_not_auto_committed"; kind: DocKind; receipt: ReceiptRow };

export interface CommitOptions {
  /** 既定 "manual" (API から)。 OCR 完了時の自動投入は "auto" */
  trigger?: CommitTrigger;
  /**
   * 種別ごとの投入先。 未指定なら receipt / handwritten だけを扱う既定
   * (`RECEIPTS_ONLY_DESTINATIONS`) になる。
   */
  destinations?: KindDestinations;
}

/**
 * receipt を投入する。 既に投入済なら冪等に成功を返す。
 * 種別が投入を許さない / 完備していない / 重複している場合は投入せず理由を返す。
 */
export function commitReceipt(repo: ReceiptsRepo, id: string, opts: CommitOptions = {}): CommitOutcome {
  const trigger = opts.trigger ?? "manual";
  const destinations = opts.destinations ?? RECEIPTS_ONLY_DESTINATIONS;
  const r = repo.find(id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.committed_at != null) return { ok: true, already: true, receipt: r };

  if (DOC_KIND_INFO[r.doc_kind]?.commitPolicy === "manual_only" && trigger === "auto") {
    return { ok: false, reason: "needs_review", kind: r.doc_kind, receipt: r };
  }

  // 投入先が無い種別 (`other`) はここで止まる。 投入先を渡さずに呼ばれた場合も同じ扱い。
  const delivery = destinations.for(r.doc_kind);
  if (!delivery) return { ok: false, reason: "kind_not_auto_committed", kind: r.doc_kind, receipt: r };

  const missing = delivery.missing(r);
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing };

  const dup = findCommittedDuplicate(repo, r);
  if (dup) return { ok: false, reason: "duplicate", existingId: dup.id, receipt: r };

  const detail = destinations.atomic(() => {
    const d = delivery.deliver(r);
    repo.commit(id);
    return d;
  });
  return {
    ok: true,
    already: false,
    receipt: repo.find(id) ?? r,
    delivery: { kind: r.doc_kind, detail },
  };
}

/**
 * 投入済の中の重複。 receipt / handwritten は index の効く (date, total) 絞り込みを使い、
 * それ以外は同種別の投入済と重複キーを突き合わせる。 キーが作れない種別は重複判定をしない。
 */
function findCommittedDuplicate(repo: ReceiptsRepo, r: ReceiptRow): ReceiptRow | undefined {
  if (r.doc_kind === "receipt" || r.doc_kind === "handwritten") {
    return repo.findCommittedDuplicate(r.date!, r.payee!, r.total!, r.id);
  }
  const key = kindDuplicateKey(r);
  if (!key) return undefined;
  return repo.listCommittedByKind(r.doc_kind).find((c) => c.id !== r.id && kindDuplicateKey(c) === key);
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

export type { KindDestinations };

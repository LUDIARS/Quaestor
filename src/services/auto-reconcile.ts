/**
 * 投入済レシート × 取引の自動突合を「到着順に依存しない」形で回す。
 *
 * @implements SPEC-RECEIPT-AUTO-INTAKE-002 (spec/feature/receipt-auto-intake.md)
 *
 * レシートとクレカ明細はどちらが先に入るか分からない:
 *  - 買い物直後にスキャン → 数日後に明細が取り込まれる
 *  - 明細を先に取り込み → 後からレシートをまとめてスキャン
 *
 * そのため突合は片側のイベントで完結させず、 「未突合の投入済レシート」を
 * 母集団にした sweep として実装し、 レシート投入時と取引取込時の両方から
 * 同じ sweep を呼ぶ。 どちらが後に来ても、 後から来た側の契機で成立する。
 */

import type Database from "better-sqlite3";
import type { ReceiptRow, ReceiptsRepo } from "../db/receipts-repo.js";
import type { ReconciliationsRepo } from "../db/reconciliations-repo.js";
import { findCandidates } from "./reconcile.js";

/** auto-match の既定閾値。 これ未満のスコアは人間の承認へ回す。 */
export const AUTO_MATCH_THRESHOLD = 0.85;

/** 1 回の sweep で見るレシート上限 (取込直後の全件走査が重くなりすぎないように)。 */
const SWEEP_LIMIT = 1000;

export interface AutoReconcileDeps {
  db: Database.Database;
  receipts: ReceiptsRepo;
  reconciliations: ReconciliationsRepo;
}

export interface AutoReconcileOptions {
  /** 既定 0.85 */
  threshold?: number;
  /** 対象レシートを明示する (省略時は未突合の投入済レシート全件)。 */
  receiptIds?: string[];
}

export interface AutoReconcileMatch {
  receipt_id: string;
  transaction_id: string;
  confidence: number;
}

export interface AutoReconcileSkip {
  receipt_id: string;
  reason: string;
}

export interface AutoReconcileResult {
  threshold: number;
  matched: AutoReconcileMatch[];
  skipped: AutoReconcileSkip[];
}

/**
 * 未突合の投入済レシートを取引に突き合わせ、 閾値以上を確定する。
 * 未投入レシートは帳簿の対象外なので母集団に含めない。
 */
export function autoReconcile(
  deps: AutoReconcileDeps,
  opts: AutoReconcileOptions = {},
): AutoReconcileResult {
  const threshold = opts.threshold ?? AUTO_MATCH_THRESHOLD;

  const targets = opts.receiptIds
    ? opts.receiptIds
        .map((id) => deps.receipts.find(id))
        .filter((r): r is ReceiptRow => r != null)
        .filter((r) => r.committed_at != null)
        .filter((r) => deps.reconciliations.byReceipt(r.id).length === 0)
    : unreconciledCommittedReceipts(deps.db);

  const matched: AutoReconcileMatch[] = [];
  const skipped: AutoReconcileSkip[] = [];

  for (const r of targets) {
    // findCandidates は毎回 reconciliations を読み直すので、
    // 同一 sweep 中に確定した取引は次のレシートでは候補から外れる。
    const top = findCandidates(deps.db, r)[0];
    if (!top) {
      skipped.push({ receipt_id: r.id, reason: "no candidates" });
      continue;
    }
    if (top.score.total < threshold) {
      skipped.push({
        receipt_id: r.id,
        reason: `top score ${top.score.total.toFixed(2)} < ${threshold}`,
      });
      continue;
    }
    const id = deps.reconciliations.insert({
      receipt_id: r.id,
      transaction_id: top.transaction.id,
      matched_by: "auto",
      confidence: top.score.total,
    });
    if (id == null) {
      skipped.push({ receipt_id: r.id, reason: "duplicate (race)" });
      continue;
    }
    matched.push({
      receipt_id: r.id,
      transaction_id: top.transaction.id,
      confidence: top.score.total,
    });
  }

  return { threshold, matched, skipped };
}

/** 投入済かつ、 まだどの取引にも紐付いていないレシート。 */
function unreconciledCommittedReceipts(db: Database.Database): ReceiptRow[] {
  return db
    .prepare(
      `SELECT r.* FROM receipts r
       WHERE r.committed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM reconciliations rc WHERE rc.receipt_id = r.id)
       ORDER BY r.date DESC
       LIMIT ?`,
    )
    .all(SWEEP_LIMIT) as ReceiptRow[];
}

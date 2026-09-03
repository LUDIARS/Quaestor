/**
 * スキャン後の「取り込み」を人手を介さず終端まで進める。
 *
 *   撮影 → OCR → (完備なら) 投入 → クレカ取引と突合
 *
 * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
 * @implements SPEC-RECEIPT-AUTO-INTAKE-002 (spec/feature/receipt-auto-intake.md)
 *
 * OCR 抽出の精度が実運用で十分に出ているため、 投入の押下を人間の作業として
 * 残さない。 ただし判断を省くわけではなく、 receipt-commit.ts の完備判定と
 * 重複判定はそのまま通す。 弾かれたレシート (欠損・重複) だけが手動確認へ残る。
 *
 * 突合は auto-reconcile.ts の sweep に委ね、 取引取込側からも同じ sweep を
 * 呼ぶことで、 レシートと明細のどちらが先に入っても成立させる。
 */

import type Database from "better-sqlite3";
import type { ReceiptsRepo } from "../db/receipts-repo.js";
import type { ReconciliationsRepo } from "../db/reconciliations-repo.js";
import { commitReceipt, commitReasonCode, type CommitOutcome } from "./receipt-commit.js";
import { autoReconcile, type AutoReconcileResult } from "./auto-reconcile.js";

export interface ReceiptIntakeDeps {
  db: Database.Database;
  receipts: ReceiptsRepo;
  reconciliations: ReconciliationsRepo;
  /** false で自動投入・自動突合を止める (手動運用へ戻す)。 既定 true */
  enabled?: boolean;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
}

export interface IntakeOutcome {
  /** enabled=false / OCR 未完で何もしなかった場合 false */
  attempted: boolean;
  commit?: CommitOutcome;
  reconcile?: AutoReconcileResult;
}

/** 自動投入の対象とする OCR 状態。 processing / pending / failed は対象外。 */
const COMMITTABLE_STATUSES = new Set(["done", "manual"]);

export class ReceiptIntake {
  private readonly enabled: boolean;

  constructor(private readonly deps: ReceiptIntakeDeps) {
    this.enabled = deps.enabled ?? true;
  }

  /**
   * OCR 結果が書き込まれた直後に呼ぶ。 完備していれば投入し、 投入できたら突合する。
   * 例外は握り潰す (OCR 結果の保存自体を失敗させない)。
   */
  afterOcr(receiptId: string): IntakeOutcome {
    if (!this.enabled) return { attempted: false };
    const r = this.deps.receipts.find(receiptId);
    if (!r || !COMMITTABLE_STATUSES.has(r.ocr_status)) return { attempted: false };

    try {
      // 自動投入は trigger="auto": handwritten 等は要確認に残す (spec SPEC-SCAN-KIND-001)
      const commit = commitReceipt(this.deps.receipts, receiptId, { trigger: "auto" });
      if (!commit.ok) {
        this.deps.logger?.info?.({ id: receiptId, reason: commitReasonCode(commit) }, "receipt auto-commit skipped");
        return { attempted: true, commit };
      }
      const reconcile = this.reconcile([receiptId]);
      return { attempted: true, commit, reconcile };
    } catch (e: unknown) {
      this.deps.logger?.warn?.(
        { id: receiptId, err: e instanceof Error ? e.message : String(e) },
        "receipt auto-intake failed",
      );
      return { attempted: true };
    }
  }

  /** 手動投入の直後に呼ぶ。 投入済レシートを取引へ突き合わせる。 */
  afterCommit(receiptId: string): AutoReconcileResult | undefined {
    if (!this.enabled) return undefined;
    return this.reconcile([receiptId]);
  }

  /**
   * 取引が取り込まれた直後に呼ぶ。 既に投入済で未突合のレシートを取引側から拾い直す。
   * レシートが先・明細が後、 という到着順を成立させる経路。
   */
  afterTransactionsImported(): AutoReconcileResult | undefined {
    if (!this.enabled) return undefined;
    return this.reconcile();
  }

  private reconcile(receiptIds?: string[]): AutoReconcileResult | undefined {
    try {
      return autoReconcile(
        { db: this.deps.db, receipts: this.deps.receipts, reconciliations: this.deps.reconciliations },
        receiptIds ? { receiptIds } : {},
      );
    } catch (e: unknown) {
      this.deps.logger?.warn?.(
        { err: e instanceof Error ? e.message : String(e) },
        "auto reconcile failed",
      );
      return undefined;
    }
  }
}

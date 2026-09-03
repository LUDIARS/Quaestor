/**
 * 「測定系が死んでいる」ことを画面に出すための警告条件 (純関数)。
 *
 * OCR-GA は稼働開始 (2026-06-11) から一度も世代が進んでいなかったのに誰も気付かなかった。
 * 進化の状態と sidecar の生死がどこにも表示されていなかったからで、これを直すのが
 * 「OCR 進化」カードの主目的 (設計書 §0-2(c))。
 *
 * ここで見るのは **測定系が動いているか**だけ。「GA が効いている / いない」の判定
 * (20 世代で baseline +0.05 など) は閾値が仮置きなので自動化しない (設計書 §3.2)。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import type { GaStatusWarning } from "./status-types.js";

/** 最終評価がこれより古ければ「止まっている」とみなす (夜間バッチは 1 日 1 回) */
export const STALE_EVALUATION_MS = 48 * 60 * 60 * 1_000;

export interface GaStatusWarningInput {
  /** 判定時刻 (epoch ms)。注入してテストを決定的にする */
  now: number;
  /** bench-report.json が読めたか */
  benchReportPresent: boolean;
  /** report の最終評価時刻 (ISO8601)。report が無ければ null */
  benchReportTs: string | null;
  /** report 中で実際にコーパスを評価したラベル数 (corpus.total > 0) */
  evaluatedLabels: number;
  /** sidecar `/health` に到達して ok:true だったか */
  sidecarHealthy: boolean;
  /** 不達 / ok:false の理由 (メッセージに添える)。無ければ null */
  sidecarDetail: string | null;
  /** 最終評価がこれより古ければ警告 (既定 48 時間) */
  staleAfterMs?: number;
}

/**
 * 警告を並び順固定で返す (report 欠落 → 評価 0 件 → 陳腐化 → sidecar)。
 * 警告が無ければ空配列。判定はここだけに置き、web は文言を出すだけにする。
 */
export function computeGaStatusWarnings(input: GaStatusWarningInput): GaStatusWarning[] {
  const warnings: GaStatusWarning[] = [];

  if (!input.benchReportPresent) {
    warnings.push({
      code: "bench_report_missing",
      message: "bench-report.json がありません。夜間バッチが一度も完走していません。",
    });
  } else if (input.evaluatedLabels === 0) {
    // report はあるのに中身が空 = コーパスが作れていない (ラベル未付与 / 画像欠落)
    warnings.push({
      code: "no_evaluations",
      message: "評価されたラベルが 0 件です。コーパスが空のままバッチが終わっています。",
    });
  }

  const staleAfterMs = input.staleAfterMs ?? STALE_EVALUATION_MS;
  const lastEvaluatedAt = input.benchReportTs ? Date.parse(input.benchReportTs) : Number.NaN;
  if (Number.isFinite(lastEvaluatedAt) && input.now - lastEvaluatedAt >= staleAfterMs) {
    warnings.push({
      code: "stale_evaluation",
      message: `最終評価が ${formatHours(input.now - lastEvaluatedAt)} 前です (${formatHours(staleAfterMs)}以上経過)。夜間バッチが止まっています。`,
    });
  }

  if (!input.sidecarHealthy) {
    warnings.push({
      code: "sidecar_unreachable",
      message: `OCR sidecar に到達できません${input.sidecarDetail ? ` (${input.sidecarDetail})` : ""}。バッチも撮影時検出も動きません。`,
    });
  }

  return warnings;
}

function formatHours(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} 時間`;
  return `${Math.floor(hours / 24)} 日`;
}

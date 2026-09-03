/**
 * 本物 BB (source=real) を学習データセットへ載せる共通経路。
 *
 * 供給元は 2 つあり、どちらも同じ形で保存する:
 *  - 撮影時の backend detect (`receipt-detect/detect-service.ts`) — PaddleOCR 経由の本物 BB
 *  - confirm 後に web が送る `POST /v1/receipts/:id/regions` — Tesseract 等ブラウザ側の本物 BB
 *
 * 保存 → 差分算出 (毎回・安価) → 差分がある時だけ Opus 類推 (fire-and-forget) の順は
 * spec/feature/scanner-overlay.md §6 のまま。ここに集約して 2 経路で同じ挙動にする。
 */

import { computeDetectionDiff, type ReferenceFields } from "./detection-eval.js";
import type { DiffEvaluator } from "./detection-diff-evaluator.js";
import type { TrainingDataset, TrainingRegion } from "./training-dataset.js";

export interface DetectionRecordDeps {
  dataset?: TrainingDataset;
  /** 差分の Opus 類推器。未設定なら差分だけ保存する */
  diffEvaluator?: DiffEvaluator;
}

export interface DetectionRecordInput {
  receiptId: string;
  /** ReceiptStorage 上の相対 path */
  imageRef: string | null;
  naturalWidth: number;
  naturalHeight: number;
  /** 検出エンジン (paddle / tesseract / …) */
  engine: string;
  /** source=real の領域だけを渡すこと (heuristic / noise は呼び出し側で捨てる) */
  regions: TrainingRegion[];
  truth: ReferenceFields;
  /** 記録時刻 (unix sec)。既定 now */
  ts?: number;
}

export interface DetectionRecordOutcome {
  saved: number;
  hasDiff: boolean;
}

/**
 * 本物 BB を追記し、真値との差分を付ける。dataset 未設定 / 領域 0 件なら何もしない。
 * Opus 類推は HTTP 応答をブロックしない (fire-and-forget)。
 */
export function recordDetection(deps: DetectionRecordDeps, input: DetectionRecordInput): DetectionRecordOutcome {
  const dataset = deps.dataset;
  if (!dataset || input.regions.length === 0) return { saved: 0, hasDiff: false };

  const recordRef = dataset.append({
    receiptId: input.receiptId,
    imageRef: input.imageRef,
    naturalWidth: input.naturalWidth,
    naturalHeight: input.naturalHeight,
    engine: input.engine,
    regions: input.regions,
    ts: input.ts ?? Math.floor(Date.now() / 1000),
  });
  if (!recordRef) return { saved: 0, hasDiff: false };

  const diff = computeDetectionDiff(
    input.regions.map((r) => ({ label: r.label, text: r.text })),
    input.truth,
  );

  if (diff.hasDiff && deps.diffEvaluator) {
    const evaluator = deps.diffEvaluator;
    void evaluator.evaluate(diff, input.engine).then(
      (inference) => dataset.attachEval(recordRef, diff, inference ?? undefined),
      () => dataset.attachEval(recordRef, diff),
    ).catch(() => {
      // primary record は保存済み。終了後の best-effort 評価添付失敗を unhandled rejection にしない。
    });
  } else {
    dataset.attachEval(recordRef, diff);
  }

  return { saved: input.regions.length, hasDiff: diff.hasDiff };
}

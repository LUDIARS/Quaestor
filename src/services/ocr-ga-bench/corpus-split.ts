/**
 * ベンチマークコーパスの train / holdout 分割。
 *
 * receipt id のハッシュで決める (乱数・実行順・件数に依存しない) ので、コーパスに
 * レシートが増えても既存レシートの所属は変わらず、世代をまたいで holdout が汚れない。
 *
 * @implements SPEC-OCR-GA-EVAL-001 (spec/feature/ocr-ga-evaluation.md)
 */

import { createHash } from "node:crypto";

/** holdout に回す割合 (train 80 / holdout 20) */
export const DEFAULT_HOLDOUT_RATIO = 0.2;

/** receipt id → 0 以上 1 未満の決定的なバケット値 (sha1 先頭 32 bit) */
export function holdoutBucket(receiptId: string): number {
  const head = createHash("sha1").update(receiptId, "utf8").digest("hex").slice(0, 8);
  return Number.parseInt(head, 16) / 0x1_0000_0000;
}

export function isHoldout(receiptId: string, ratio = DEFAULT_HOLDOUT_RATIO): boolean {
  return holdoutBucket(receiptId) < ratio;
}

export function splitHoldout<T extends { receiptId: string }>(
  entries: readonly T[],
  ratio = DEFAULT_HOLDOUT_RATIO,
): { train: T[]; holdout: T[] } {
  const train: T[] = [];
  const holdout: T[] = [];
  for (const e of entries) (isHoldout(e.receiptId, ratio) ? holdout : train).push(e);
  return { train, holdout };
}

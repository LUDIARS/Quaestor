/**
 * Receipts の OCR 実行を集約。
 *
 * - 1 枚の receipt id を受け取って OCR client を呼び、 結果を repo.setOcrResult に書く
 * - status を 'processing' → 'done' / 'failed' / 'manual' に遷移
 * - confidence='low' は 'manual' に倒して人間レビュー待ち
 *
 * API hook (POST /v1/receipts/:id/ocr/run) と将来の poll worker 双方からこの関数を呼ぶ。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
 */

import type { ReceiptsRepo } from "../db/receipts-repo.js";
import type { ReceiptStorage } from "./receipt-storage.js";
import type { OcrClient } from "./ocr-client.js";
import type { ReceiptIntake } from "./receipt-intake.js";
import { applyLlmLabels } from "./receipt-labels.js";

export interface OcrRunResult {
  ok: boolean;
  status: "done" | "failed" | "manual";
  message?: string;
}

export interface OcrRunnerDeps {
  receipts: ReceiptsRepo;
  storage: ReceiptStorage;
  client: OcrClient;
  /** 抽出成功後の自動投入 + 自動突合。 未設定なら投入は手動のまま */
  intake?: ReceiptIntake;
}

export async function runOcrFor(receiptId: string, deps: OcrRunnerDeps): Promise<OcrRunResult> {
  const r = deps.receipts.find(receiptId);
  if (!r) return { ok: false, status: "failed", message: "receipt not found" };
  if (r.committed_at != null) {
    return { ok: false, status: "failed", message: "receipt already committed" };
  }
  if (!r.image_path) return markFailed(deps.receipts, receiptId, "no image_path");

  const buf = deps.storage.load(r.image_path);
  if (!buf) return markFailed(deps.receipts, receiptId, "image file missing");

  // mime 判定 (path 末尾の拡張子から)
  const ext = (r.image_path.split(".").pop() ?? "").toLowerCase();
  const mime = ext === "png" ? "image/png" : "image/jpeg";

  // 'processing' に遷移
  deps.receipts.setOcrResult(receiptId, { ocr_status: "processing" });

  try {
    const result = await deps.client.extract(buf, mime);
    const status: "done" | "manual" = result.confidence === "low" ? "manual" : "done";
    deps.receipts.setOcrResult(receiptId, {
      ocr_status: status,
      date: result.date,
      payee: result.payee,
      total: result.total,
      items: result.items,
      ocr_raw: result.raw,
    });
    // Classification must be persisted before intake evaluates doc_kind.
    // Optional keeps compatibility with injected clients implementing the old result shape.
    if (result.labels) applyLlmLabels(deps.receipts, receiptId, result.labels);
    deps.intake?.afterOcr(receiptId);
    return { ok: true, status };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return markFailed(deps.receipts, receiptId, msg);
  }
}

function markFailed(repo: ReceiptsRepo, id: string, message: string): OcrRunResult {
  repo.setOcrResult(id, { ocr_status: "failed", ocr_raw: JSON.stringify({ error: message }) });
  return { ok: false, status: "failed", message };
}

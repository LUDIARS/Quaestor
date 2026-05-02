/**
 * pending receipts を一定間隔でポーリングして OCR worker に流す background task。
 *
 * 設計:
 *  - 1 tick で 1 件だけ処理 (Anthropic API レート + メモリ占有を抑える)
 *  - tick 中に新規到来した tick は in-flight 中なので skip
 *  - failed は対象外 (ユーザが手動 retry button で再実行)
 *  - 起動・停止は外部から制御 (server.ts がライフサイクルを持つ)
 */

import type { ReceiptsRepo } from "../db/receipts-repo.js";
import type { ReceiptStorage } from "./receipt-storage.js";
import type { OcrClient } from "./ocr-client.js";
import { runOcrFor } from "./ocr-runner.js";

export interface OcrWorkerDeps {
  receipts: ReceiptsRepo;
  storage: ReceiptStorage;
  client: OcrClient;
  /** ポーリング間隔 (ms)。 既定 30000 = 30 秒 */
  intervalMs?: number;
  /** ログハンドル (pino インスタンスのサブセット)。 省略可 */
  logger?: { info?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

export class OcrWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly intervalMs: number;

  constructor(private readonly deps: OcrWorkerDeps) {
    this.intervalMs = deps.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.deps.logger?.info?.({ intervalMs: this.intervalMs }, "ocr worker started");
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.deps.logger?.info?.("ocr worker stopped");
  }

  /** テスト用: 1 回だけ処理して結果を返す (タイマー無し) */
  async tickOnce(): Promise<{ processed: boolean; receiptId?: string; status?: string }> {
    if (this.running) return { processed: false };
    this.running = true;
    try {
      const pending = this.deps.receipts.list({ status: "pending", limit: 1 });
      const target = pending.find((r) => r.image_path);
      if (!target) return { processed: false };
      const result = await runOcrFor(target.id, {
        receipts: this.deps.receipts,
        storage: this.deps.storage,
        client: this.deps.client,
      });
      return { processed: true, receiptId: target.id, status: result.status };
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.running) {
      this.running = true;
      try {
        const pending = this.deps.receipts.list({ status: "pending", limit: 1 });
        const target = pending.find((r) => r.image_path);
        if (target) {
          const r = await runOcrFor(target.id, {
            receipts: this.deps.receipts,
            storage: this.deps.storage,
            client: this.deps.client,
          });
          this.deps.logger?.info?.({ id: target.id, status: r.status }, "ocr worker processed");
        }
      } catch (e: unknown) {
        this.deps.logger?.error?.({ err: e instanceof Error ? e.message : String(e) }, "ocr worker tick error");
      } finally {
        this.running = false;
      }
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    }
  }
}

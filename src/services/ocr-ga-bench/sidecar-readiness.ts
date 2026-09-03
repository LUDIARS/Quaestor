/**
 * バッチ開始時に sidecar の `/health` が答えられるようになるまで待つ。
 *
 * GPU sidecar は最初の `/health` で初めて paddle を import し、CUDA を初期化して
 * カーネルを読む。実測 (B-6、GTX 1070) で **約 7.4 秒**かかり、`HttpOcrSidecarClient` の
 * `/health` 既定タイムアウト (5 秒) を超える。1 回で諦めると「マシン再起動後の最初の
 * 夜間バッチだけ必ず sidecar 不達で落ちる」ので、短い間隔で数回だけ待つ。
 *
 * 中断されたリクエストの裏で sidecar の初期化は進むため、2〜3 回目の `/health` は即答する。
 *
 * 待つのは **応答できない間 (接続不可 / タイムアウト) だけ**。`ok:false` や device 不一致は
 * sidecar が出した明確な答えなので、ここでは再試行せず呼び出し側の判断に返す (§7.1 fail-fast)。
 *
 * @implements SPEC-OCR-GA-EVAL-005 (spec/feature/ocr-ga-evaluation.md)
 */

import type { OcrSidecarClient, SidecarHealth } from "../ocr-sidecar-client.js";
import type { BenchLogger } from "./types.js";

/** `/health` を試す回数 (既定)。5 秒タイムアウト × 4 回 + 待ちで GPU の cold start に足りる */
export const DEFAULT_HEALTH_ATTEMPTS = 4;
const MAX_HEALTH_ATTEMPTS = 100;
/** 失敗してから次に試すまでの待ち (既定、ms) */
export const DEFAULT_HEALTH_RETRY_DELAY_MS = 1_000;
const MAX_HEALTH_RETRY_DELAY_MS = 60_000;

export interface SidecarReadinessOptions {
  attempts?: number;
  retryDelayMs?: number;
  /** テスト用: 待ちの差し替え */
  sleep?: (ms: number) => Promise<void>;
  logger?: BenchLogger;
}

/** `/health` が答えるまで待って返す。最後まで答えなければ最後のエラーを添えて投げる */
export async function waitForSidecarHealth(
  sidecar: Pick<OcrSidecarClient, "baseUrl" | "health">,
  opts: SidecarReadinessOptions = {},
): Promise<SidecarHealth> {
  const configuredAttempts = opts.attempts ?? DEFAULT_HEALTH_ATTEMPTS;
  if (!Number.isFinite(configuredAttempts) || configuredAttempts < 1 || configuredAttempts > MAX_HEALTH_ATTEMPTS) {
    throw new RangeError(`sidecar health attempts must be between 1 and ${MAX_HEALTH_ATTEMPTS}`);
  }
  const attempts = Math.trunc(configuredAttempts);

  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_HEALTH_RETRY_DELAY_MS;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_HEALTH_RETRY_DELAY_MS) {
    throw new RangeError(`sidecar health retryDelayMs must be between 0 and ${MAX_HEALTH_RETRY_DELAY_MS}`);
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sidecar.health();
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt >= attempts) break;
      opts.logger?.warn?.(
        { sidecar: sidecar.baseUrl, attempt, attempts, err: lastError },
        "ga bench sidecar health not ready yet; retrying (gpu cold start takes ~8s)",
      );
      await sleep(retryDelayMs);
    }
  }
  throw new Error(`OCR sidecar unreachable at ${sidecar.baseUrl} after ${attempts} attempts: ${lastError}`);
}

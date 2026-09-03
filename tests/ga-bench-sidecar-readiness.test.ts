/**
 * sidecar `/health` の cold start 待ち (SPEC-OCR-GA-EVAL-005)。
 *
 * GPU sidecar は最初の `/health` で CUDA を初期化するため、client の `/health`
 * タイムアウト (5 秒) より遅い。1 回で不達と判定すると、マシン再起動後の最初の
 * 夜間バッチだけ必ず落ちる。待つのは「答えられない間」だけで、`ok:false` のような
 * 明確な答えは呼び出し側に返す。
 */
import { describe, it, expect, vi } from "vitest";
import {
  waitForSidecarHealth,
  DEFAULT_HEALTH_ATTEMPTS,
  DEFAULT_HEALTH_RETRY_DELAY_MS,
} from "../src/services/ocr-ga-bench/sidecar-readiness.js";
import type { SidecarHealth } from "../src/services/ocr-sidecar-client.js";

const GPU_HEALTH: SidecarHealth = {
  ok: true, model: "PP-OCRv5/japan", device: "gpu", requestedDevice: "gpu", deviceError: null, paddleocrMajor: 3,
};

/** health() が最初の `failures` 回だけ投げ、その後 `result` を返す偽 sidecar */
function sidecarFailingTimes(failures: number, result: SidecarHealth = GPU_HEALTH) {
  let calls = 0;
  return {
    baseUrl: "http://fake-sidecar",
    health: async (): Promise<SidecarHealth> => {
      calls += 1;
      if (calls <= failures) throw new Error("sidecar request timed out after 5000 ms: http://fake-sidecar/health");
      return result;
    },
    get calls() { return calls; },
  };
}

describe("waitForSidecarHealth", () => {
  it("cold start 中のタイムアウトを待って、答えられるようになった health を返す", async () => {
    const sidecar = sidecarFailingTimes(2);
    const sleep = vi.fn(async () => {});

    const health = await waitForSidecarHealth(sidecar, { sleep });

    expect(health).toEqual(GPU_HEALTH);
    expect(sidecar.calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(DEFAULT_HEALTH_RETRY_DELAY_MS);
  });

  it("最初から答えるなら 1 回で返し、待たない", async () => {
    const sidecar = sidecarFailingTimes(0);
    const sleep = vi.fn(async () => {});

    await waitForSidecarHealth(sidecar, { sleep });

    expect(sidecar.calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("既定回数を使い切っても答えなければ、最後のエラーを添えて投げる (黙って縮退しない)", async () => {
    const sidecar = sidecarFailingTimes(Number.MAX_SAFE_INTEGER);
    const sleep = vi.fn(async () => {});

    await expect(waitForSidecarHealth(sidecar, { sleep })).rejects.toThrow(
      /unreachable at http:\/\/fake-sidecar after 4 attempts: sidecar request timed out after 5000 ms/,
    );
    expect(sidecar.calls).toBe(DEFAULT_HEALTH_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(DEFAULT_HEALTH_ATTEMPTS - 1);
  });

  it("attempts / retryDelayMs を指定できる。attempts=1 は再試行しない", async () => {
    const once = sidecarFailingTimes(Number.MAX_SAFE_INTEGER);
    const sleep = vi.fn(async () => {});
    await expect(waitForSidecarHealth(once, { attempts: 1, sleep })).rejects.toThrow(/after 1 attempts/);
    expect(once.calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();

    const slow = sidecarFailingTimes(1);
    const sleep2 = vi.fn(async () => {});
    await waitForSidecarHealth(slow, { attempts: 3, retryDelayMs: 250, sleep: sleep2 });
    expect(sleep2).toHaveBeenCalledWith(250);
  });

  it("無限待ちや即時再試行になる不正な待機設定を拒否する", async () => {
    const sidecar = sidecarFailingTimes(0);

    await expect(waitForSidecarHealth(sidecar, { attempts: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /attempts must be between 1 and 100/,
    );
    await expect(waitForSidecarHealth(sidecar, { retryDelayMs: Number.NaN })).rejects.toThrow(
      /retryDelayMs must be between 0 and 60000/,
    );
    expect(sidecar.calls).toBe(0);
  });

  it("ok:false は sidecar が出した答えなので待たずにそのまま返す (device 判定は呼び出し側)", async () => {
    const down: SidecarHealth = { ...GPU_HEALTH, ok: false, device: "cpu", deviceError: "CUDA error: invalid PTX" };
    const sidecar = sidecarFailingTimes(0, down);
    const sleep = vi.fn(async () => {});

    const health = await waitForSidecarHealth(sidecar, { sleep });

    expect(health.ok).toBe(false);
    expect(sidecar.calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

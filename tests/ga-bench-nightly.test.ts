import { describe, it, expect } from "vitest";
import { GaBenchNightlyJob, nextRunDelayMs } from "../src/services/ocr-ga-bench/nightly-job.js";
import type { BenchReport } from "../src/services/ocr-ga-bench/types.js";

const EMPTY_REPORT: BenchReport = { ts: "t", sidecarUrl: "u", device: "cpu", labels: [] };

describe("nextRunDelayMs", () => {
  it("今日の hour がまだ来ていなければ今日、過ぎていれば明日", () => {
    const at = (h: number, m = 0) => { const d = new Date(2026, 8, 3, h, m, 0, 0); return d; };
    expect(nextRunDelayMs(at(1), 3)).toBe(2 * 60 * 60 * 1000);
    expect(nextRunDelayMs(at(3), 3)).toBe(24 * 60 * 60 * 1000);   // ちょうどは明日
    expect(nextRunDelayMs(at(4, 30), 3)).toBe((24 - 1.5) * 60 * 60 * 1000);
    expect(nextRunDelayMs(at(23, 59), 0)).toBe(60 * 1000);
  });

  it("範囲外の hour は 0-23 に丸める", () => {
    const now = new Date(2026, 8, 3, 12, 0, 0, 0);
    expect(nextRunDelayMs(now, 99)).toBe(nextRunDelayMs(now, 23));
    expect(nextRunDelayMs(now, -5)).toBe(nextRunDelayMs(now, 0));
  });
});

describe("GaBenchNightlyJob", () => {
  it("start は次回時刻にタイマーを張り、発火で run → 再スケジュール、stop で解除", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let cleared = 0;
    let runs = 0;
    const job = new GaBenchNightlyJob({
      hour: 3,
      run: async () => { runs += 1; return EMPTY_REPORT; },
      now: () => new Date(2026, 8, 3, 1, 0, 0, 0),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => { cleared += 1; },
    });
    job.start();
    job.start(); // 二重起動しない
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(2 * 60 * 60 * 1000);

    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1);
    expect(timers).toHaveLength(2); // 次回が張られる

    job.stop();
    expect(cleared).toBe(1);
    timers[1]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers).toHaveLength(2); // stop 後は再スケジュールしない
  });

  it("runOnce: 実行中の重複は skip、失敗は error として返しプロセスを落とさない", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const job = new GaBenchNightlyJob({ hour: 3, run: async () => { await gate; return EMPTY_REPORT; } });
    const first = job.runOnce();
    expect(await job.runOnce()).toEqual({ ran: false });
    release();
    expect((await first).ran).toBe(true);

    const warned: string[] = [];
    const failing = new GaBenchNightlyJob({
      hour: 3,
      run: async () => { throw new Error("sidecar unreachable"); },
      logger: { warn: (_o, msg) => { warned.push(msg ?? ""); } },
    });
    const r = await failing.runOnce();
    expect(r.ran).toBe(true);
    expect(r.error).toBe("sidecar unreachable");
    expect(warned).toContain("ga bench nightly run failed");
  });
});

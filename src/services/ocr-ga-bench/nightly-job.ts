/**
 * OCR-GA 夜間評価ジョブ。
 *
 * 毎日 `hour` 時 (ローカル時刻) に 1 回 run() を呼ぶだけの薄いスケジューラ。
 * 何を評価するか (コーパス / sidecar / 世代数) は run() 側 (bench-runner.ts) が持つ。
 * ocrWorker と同じく server.ts がライフサイクル (start / stop) を持つ。
 *
 *  - 前回の run が終わっていなければその回は skip (重ねて sidecar を叩かない)
 *  - run の失敗 (sidecar 不達など) はログに出して翌日に回す。プロセスは落とさない
 *
 * @implements SPEC-OCR-GA-EVAL-003 (spec/feature/ocr-ga-evaluation.md)
 */

import type { BenchLogger, BenchReport } from "./types.js";

export interface NightlyJobDeps {
  /** 実行時 (0-23、ローカル時刻) */
  hour: number;
  run: () => Promise<BenchReport>;
  logger?: BenchLogger;
  /** テスト用: 現在時刻 */
  now?: () => Date;
  /** テスト用: タイマー差し替え */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NightlyRunOutcome {
  /** false = 前回がまだ走っていたので skip */
  ran: boolean;
  report?: BenchReport;
  error?: string;
}

/** now から次の `hour:00:00` (ローカル) までの ms。今日のその時刻を過ぎていれば明日 */
export function nextRunDelayMs(now: Date, hour: number): number {
  const h = Math.min(23, Math.max(0, Math.floor(hour)));
  const next = new Date(now.getTime());
  next.setHours(h, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export class GaBenchNightlyJob {
  private timer: unknown = null;
  private running = false;
  private stopped = false;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: NightlyJobDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.deps.logger?.info?.({}, "ga bench nightly job stopped");
  }

  /** 1 回だけ実行 (タイマー無し)。テストと手動起動用 */
  async runOnce(): Promise<NightlyRunOutcome> {
    if (this.running) return { ran: false };
    this.running = true;
    try {
      const report = await this.deps.run();
      this.deps.logger?.info?.(
        { labels: report.labels.map((l) => ({ label: l.label, generation: l.generation, best: l.best.fitness, baseline: l.baseline.fitness })) },
        "ga bench nightly run finished",
      );
      return { ran: true, report };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.deps.logger?.warn?.({ err: error }, "ga bench nightly run failed");
      return { ran: true, error };
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = nextRunDelayMs(this.now(), this.deps.hour);
    this.deps.logger?.info?.({ hour: this.deps.hour, delayMs: delay }, "ga bench nightly job scheduled");
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.schedule());
    }, delay);
  }
}

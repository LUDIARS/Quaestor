/**
 * 「OCR 進化」カードの 1 行 = 1 ラベル (global / tag:<形状タグ>)。
 *
 * bench-report.json の値 (今どうか) と evolution.jsonl の推移を並べるだけ。
 * best が baseline を超えているかどうかの **判定はしない** (設計書 §3.2)。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import { TrendChart } from "./TrendChart";
import type { GaStatusLabel, ScoreSummary } from "./types";

export function LabelRow({ label }: { label: GaStatusLabel }) {
  const bench = label.bench;
  return (
    <div className="border rounded p-2 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <code className="text-sm font-semibold">{label.label}</code>
        {bench ? (
          <span className="text-xs text-gray-500">
            第 {bench.generation} 世代 / train {bench.corpus.train} + holdout {bench.corpus.holdout} 件
            {bench.reseeded && <span className="ml-1 text-amber-600">再 seed</span>}
          </span>
        ) : (
          <span className="text-xs text-gray-400">bench-report.json に無し</span>
        )}
      </div>

      {bench && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
            <Metric name="best" value={bench.best.fitness.toFixed(3)} />
            <Metric name="mean" value={bench.mean.toFixed(3)} />
            <Metric name="baseline" value={bench.baseline.fitness.toFixed(3)} />
            <Metric name="holdout best" value={fitnessOf(bench.holdout.best)} />
            <Metric name="holdout baseline" value={fitnessOf(bench.holdout.baseline)} />
            <Metric name="1 個体" value={`${bench.secondsPerIndividual.toFixed(1)} 秒`} />
          </div>
          <div className="text-xs text-gray-500">
            field hit (best): date {pct(bench.best.fieldHitRate.date)} / payee {pct(bench.best.fieldHitRate.payee)}
            {" / "}total {pct(bench.best.fieldHitRate.total)}
            {" — "}baseline: date {pct(bench.baseline.fieldHitRate.date)} / payee {pct(bench.baseline.fieldHitRate.payee)}
            {" / "}total {pct(bench.baseline.fieldHitRate.total)}
          </div>
          <div className="text-xs text-gray-400">
            最終評価 {new Date(bench.ts).toLocaleString()} / detect {bench.detectCalls} 回
            {bench.errors > 0 && <span className="text-amber-600"> / errors {bench.errors}</span>}
          </div>
        </>
      )}

      <TrendChart points={label.trend} />
    </div>
  );
}

function Metric({ name, value }: { name: string; value: string }) {
  return (
    <span className="text-gray-700">
      <span className="text-gray-400">{name}</span> {value}
    </span>
  );
}

function fitnessOf(summary: ScoreSummary | null): string {
  return summary ? summary.fitness.toFixed(3) : "—";
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

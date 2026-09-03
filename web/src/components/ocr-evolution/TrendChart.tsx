/**
 * evolution.jsonl の直近 N 世代を小さな折れ線で出すだけの部品。
 *
 * 「best が baseline を超えているか」を目で追うためのもので、判定 (効いている / いない) は
 * しない — 閾値は仮置きで自動化しない (設計書 §3.2)。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import type { GaGenerationPoint } from "./types";

const WIDTH = 220;
const HEIGHT = 44;
const PADDING = 3;

export function TrendChart({ points }: { points: GaGenerationPoint[] }) {
  if (points.length === 0) {
    return <div className="text-xs text-gray-400">世代の記録がありません (evolution.jsonl 無し)</div>;
  }
  if (points.length === 1) {
    const only = points[0]!;
    return (
      <div className="text-xs text-gray-500">
        第 {only.generation} 世代のみ: best {fmt(only.best)} / baseline {fmt(only.baseline)}
      </div>
    );
  }

  const values = points.flatMap((p) => [p.best, p.baseline]).filter((v): v is number => v != null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = points[0]!;
  const last = points[points.length - 1]!;

  return (
    <div className="flex items-center gap-2">
      <svg width={WIDTH} height={HEIGHT} className="shrink-0" role="img" aria-label="best と baseline の世代推移">
        <polyline
          points={polyline(points, (p) => p.baseline, min, max)}
          fill="none" stroke="#9ca3af" strokeWidth={1} strokeDasharray="3 2"
        />
        <polyline
          points={polyline(points, (p) => p.best, min, max)}
          fill="none" stroke="#2563eb" strokeWidth={1.5}
        />
      </svg>
      <div className="text-xs text-gray-500 leading-tight">
        <div>
          第 {first.generation}〜{last.generation} 世代 ({points.length} 点)
        </div>
        <div>
          <span className="text-blue-700">best {fmt(first.best)} → {fmt(last.best)}</span>
          {" / "}
          <span className="text-gray-500">baseline {fmt(last.baseline)}</span>
        </div>
      </div>
    </div>
  );
}

/** 値が null の世代は線を切らずに飛ばす (baseline は撮影時評価だと入らない) */
function polyline(
  points: GaGenerationPoint[],
  pick: (p: GaGenerationPoint) => number | null,
  min: number,
  max: number,
): string {
  const span = max - min;
  return points
    .map((p, i) => ({ value: pick(p), i }))
    .filter((v): v is { value: number; i: number } => v.value != null)
    .map(({ value, i }) => {
      const x = PADDING + (i / Math.max(1, points.length - 1)) * (WIDTH - PADDING * 2);
      const ratio = span > 0 ? (value - min) / span : 0.5;
      const y = HEIGHT - PADDING - ratio * (HEIGHT - PADDING * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function fmt(value: number | null): string {
  return value == null ? "—" : value.toFixed(3);
}

/**
 * 精度替え再スキャン演出 (analyze 中) の probe マーカー生成。
 *
 * 方針: 演出はエンジン (sidecar / Tesseract) の生死に依存しない。撮影時の検出は backend へ
 * 移り (1 回 40 秒)、analyze 中に本物の検出行は届かないので、pass 番号を seed にレシート風の
 * 行マーカーを合成する (演出専用。嘘の認識テキストは出さない)。
 *
 * delay は y 座標 → スキャンライン (sweepMs) の通過時刻。マーカーは
 * ラインが通過したタイミングで現れる。
 */

import type { DetectedRegion } from "./types.js";

const PROBE_COLOR = "#fbbf24";

/**
 * 演出用 probe。
 * pass を seed にした擬似乱数で「レシートの行」風に左寄せの横長マーカーを
 * 上から下に並べる。pass が変わると配置も変わる = 精度を変えて再スキャンした見た目。
 * テキストは持たない (嘘の認識結果は出さない)。
 */
export function synthesizeProbes(
  pass: number,
  naturalWidth: number,
  naturalHeight: number,
  sweepMs: number,
): DetectedRegion[] {
  if (naturalWidth <= 0 || naturalHeight <= 0) return [];
  const rng = mulberry32(pass * 0x9e3779b9 + 1);
  const rows = 8 + Math.floor(rng() * 5); // 8..12 行
  const regions: DetectedRegion[] = [];
  for (let i = 0; i < rows; i++) {
    // 行の中心 y: 上 12% 〜 下 88% を等間隔 + ジッタ
    const t = (i + 0.5) / rows;
    const y = naturalHeight * (0.12 + t * 0.76 + (rng() - 0.5) * 0.03);
    const h = naturalHeight * (0.016 + rng() * 0.012);
    const x = naturalWidth * (0.12 + rng() * 0.08);
    const w = naturalWidth * (0.28 + rng() * 0.46);
    regions.push({
      id:         `probe-${pass}-${i}`,
      label:      "",
      x, y, width: w, height: h,
      confidence: 0.4 + rng() * 0.5,
      color:      PROBE_COLOR,
      kind:       "probe",
      delay:      sweepDelay(y, naturalHeight, sweepMs),
    });
  }
  return regions;
}

/** y 座標がスキャンラインに追いつく時刻 (ms) */
function sweepDelay(y: number, naturalHeight: number, sweepMs: number): number {
  const f = Math.min(1, Math.max(0, y / naturalHeight));
  return Math.round(f * sweepMs * 0.9);
}

/** 決定論的な軽量 PRNG (seed 固定で同じ列を返す) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * OCR-GA 評価器 (web 側)。
 *
 * LLM(Vision) 検出待ちの間、backend の現世代パラメータ個体を取得し、各個体で
 * sidecar OCR を回して候補を貯める (画面が暇な時間を使う)。LLM 真値が来たら各候補を
 * 真値と照合して fitness を付け、backend に送って集団を進化させる (遺伝的最適化)。
 *
 * GA の骨格 (生成/変異/交叉/永続) は backend (genetic.ts) が担当。ここは「評価」だけ。
 */

import { runOcrGenome, type OcrGenome, type OcrLine } from "./ocr-genome.js";
import type { OcrFields } from "./types.js";

export interface OcrCandidate {
  genome: OcrGenome;
  lines: OcrLine[];
}

export interface EvolutionProgress {
  generation: number;
  attempt: number;   // 評価済個体数
  total: number;     // 集団サイズ
}

const GA_BASE = "/v1/ocr-ga";

export class OcrEvolver {
  private candidates: OcrCandidate[] = [];
  private generation = 0;
  private genomes: OcrGenome[] = [];

  constructor(private readonly key = "global") {}

  /** 現世代の個体を取得 (sidecar/backend 未起動なら空) */
  async loadPopulation(): Promise<OcrGenome[]> {
    try {
      const res = await fetch(`${GA_BASE}/population?key=${encodeURIComponent(this.key)}`);
      if (!res.ok) return [];
      const j = (await res.json()) as { generation: number; genomes: OcrGenome[] };
      this.generation = j.generation;
      this.genomes = j.genomes ?? [];
      return this.genomes;
    } catch { return []; }
  }

  /**
   * 待機中に個体を 1 つ評価 (sidecar OCR 実行 → 候補に蓄積)。
   * onProgress で進捗を演出に渡す。エラーはスキップ。
   */
  async evaluateAll(
    imageUrl: string,
    onProgress?: (p: EvolutionProgress) => void,
  ): Promise<void> {
    for (let i = 0; i < this.genomes.length; i++) {
      const genome = this.genomes[i]!;
      try {
        const lines = await runOcrGenome(imageUrl, genome);
        this.candidates.push({ genome, lines });
      } catch { /* sidecar 失敗はスキップ */ }
      onProgress?.({ generation: this.generation, attempt: i + 1, total: this.genomes.length });
    }
  }

  /**
   * LLM 真値で各候補を採点し、backend に世代を記録 (進化+永続)。
   * @returns 最良候補 (なければ null)
   */
  async finalize(fields: OcrFields): Promise<OcrCandidate | null> {
    if (this.candidates.length === 0) return null;
    const evaluated = this.candidates.map((c) => ({
      genome: c.genome,
      fitness: fitnessVsTruth(c.lines, fields),
    }));
    // backend に送って進化+永続 (失敗は握り潰す)
    try {
      await fetch(`${GA_BASE}/generation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: this.key, evaluated }),
      });
    } catch { /* ignore */ }

    let best: OcrCandidate | null = null;
    let bestFit = -1;
    evaluated.forEach((e, i) => {
      if (e.fitness > bestFit) { bestFit = e.fitness; best = this.candidates[i]!; }
    });
    return best;
  }
}

// ---------------------------------------------------------------------------
// fitness: 候補の認識行が LLM 真値フィールドにどれだけ一致するか (0..1)
// ---------------------------------------------------------------------------

export function fitnessVsTruth(lines: OcrLine[], fields: OcrFields): number {
  const targets: string[] = [];
  if (fields.payee) targets.push(fields.payee);
  if (fields.date) targets.push(fields.date);
  if (fields.total != null) targets.push(String(fields.total));
  if (fields.items) {
    try {
      const items = JSON.parse(fields.items) as Array<{ name?: string }>;
      for (const it of items.slice(0, 6)) if (it?.name) targets.push(it.name);
    } catch { /* ignore */ }
  }
  if (targets.length === 0 || lines.length === 0) return 0;

  const texts = lines.map((l) => l.text);
  const sum = targets.reduce((s, t) => s + bestSimilarity(t, texts), 0);
  return Number((sum / targets.length).toFixed(4));
}

function bestSimilarity(needle: string, hay: string[]): number {
  let best = 0;
  for (const h of hay) best = Math.max(best, similarity(needle, h));
  return best;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[¥,\s\-/￥、。　]/g, "");
}

function similarity(a: string, b: string): number {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    return s.length / l.length;
  }
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

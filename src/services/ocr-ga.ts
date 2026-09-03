/**
 * OCR パラメータの遺伝的最適化 — 汎用 GA エンジン (genetic.ts) の OCR 特化インスタンス。
 *
 * PaddleOCR の det/rec パラメータを遺伝子として進化させる。GA の骨格 (生成/変異/交叉/
 * 世代更新/永続) は genetic.ts に汎用化済。ここでは OCR 用の遺伝子スキーマと既定値、
 * 集団ストアの生成、そして集団キー (ラベル) の規則だけを定義する。
 *
 * 集団キーはラベル: `global` (good_sample 全体) と `tag:<形状タグ>` (special_shape の各タグ)。
 * 店舗別キー (payee 由来) は廃止した (2026-09-03、spec/feature/ocr-ga-evaluation.md)。
 * 外から来たそれ以外のキーは global に丸める。
 */

import {
  GaStore, randomGenome,
  type Genome, type GenomeSchema, type Evaluated,
} from "./genetic.js";

/** PaddleOCR det/rec パラメータ = 1 個体 */
export interface OcrGenome extends Genome {
  /** det_db_thresh 二値化閾値 */
  detThresh: number;
  /** det_db_box_thresh box 信頼足切り */
  boxThresh: number;
  /** det_db_unclip_ratio box 拡張比 */
  unclipRatio: number;
  /** det_limit_side_len 入力解像度 (長辺 px) */
  limitSideLen: number;
  /** use_dilation 膨張で細線を繋ぐ */
  useDilation: boolean;
  /** drop_score rec 信頼足切り */
  dropScore: number;
}

/** OCR 遺伝子スキーマ (genetic.ts の汎用 engine に渡す) */
export const OCR_GENE_SCHEMA: GenomeSchema = {
  detThresh:    { kind: "number", min: 0.2, max: 0.5,  round: 3 },
  boxThresh:    { kind: "number", min: 0.4, max: 0.85, round: 3 },
  unclipRatio:  { kind: "number", min: 1.3, max: 2.6,  round: 3 },
  limitSideLen: { kind: "choice", options: [736, 960, 1280, 1600] },
  useDilation:  { kind: "bool" },
  dropScore:    { kind: "number", min: 0.3, max: 0.7,  round: 3 },
};

/** PaddleOCR デフォルト近傍の遺伝子 (初期集団の第 1 個体 + ベンチマークの baseline) */
export function defaultOcrGenome(): OcrGenome {
  return { detThresh: 0.3, boxThresh: 0.6, unclipRatio: 1.6, limitSideLen: 960, useDilation: false, dropScore: 0.5 };
}

export type EvaluatedOcrGenome = Evaluated<OcrGenome>;

// ---------------------------------------------------------------------------
// 集団キー (ラベル)
// ---------------------------------------------------------------------------

/** good_sample 全体の集団キー。ラベル別集団の無いタグ・不明キーの受け皿でもある */
export const GA_GLOBAL_KEY = "global";
/** ラベル別集団を作る最小件数。未満のタグのレシートは global に含める */
export const MIN_LABEL_CORPUS = 10;
/** best が既定遺伝子 (baseline) を下回る世代がこの回数続いたら集団を再 seed する */
export const RESEED_AFTER_BELOW_BASELINE = 5;

const TAG_KEY_PREFIX = "tag:";
const TAG_PATTERN = /^[a-z0-9_]{1,32}$/;

/** 形状タグを小文字英数字と `_` に正規化する。規則外 (空・記号・長すぎ) は null */
export function normalizeTag(tag: string): string | null {
  const t = tag.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TAG_PATTERN.test(t) ? t : null;
}

/** 形状タグ → 集団キー `tag:<tag>`。不正タグは null */
export function tagGaKey(tag: string): string | null {
  const t = normalizeTag(tag);
  return t ? `${TAG_KEY_PREFIX}${t}` : null;
}

/**
 * 外部 (API / 旧 web) から来た集団キーをラベルキーに丸める。
 * 許すのは `global` と `tag:<正規タグ>` だけ。旧 payee 由来キーを含むそれ以外は global。
 * @implements SPEC-OCR-GA-EVAL-001 (spec/feature/ocr-ga-evaluation.md)
 */
export function normalizeGaKey(key: string | null | undefined): string {
  if (!key || key === GA_GLOBAL_KEY) return GA_GLOBAL_KEY;
  if (key.startsWith(TAG_KEY_PREFIX)) return tagGaKey(key.slice(TAG_KEY_PREFIX.length)) ?? GA_GLOBAL_KEY;
  return GA_GLOBAL_KEY;
}

export interface ResolvedBestGenome {
  /** 採用した集団キー (default のときは global) */
  key: string;
  source: "tag" | "global" | "default";
  /** 採用した best を記録した世代 (default は 0) */
  generation: number;
  /** その best の fitness (default は null) */
  fitness: number | null;
  genome: OcrGenome;
}

/**
 * タグ列 (優先順) から最良遺伝子を引く: `tag:<x>` の集団に記録があればそれ、
 * 無ければ global、それも無ければ既定遺伝子。撮影時 detect が使う。
 * @implements SPEC-OCR-GA-EVAL-004 (spec/feature/ocr-ga-evaluation.md)
 */
export function resolveBestGenome(store: GaStore<OcrGenome>, tags: readonly string[]): ResolvedBestGenome {
  for (const tag of tags) {
    const key = tagGaKey(tag);
    if (!key) continue;
    const b = store.best(key);
    if (b) return { key, source: "tag", generation: b.generation, fitness: b.fitness, genome: b.genome };
  }
  const g = store.best(GA_GLOBAL_KEY);
  if (g) return { key: GA_GLOBAL_KEY, source: "global", generation: g.generation, fitness: g.fitness, genome: g.genome };
  return { key: GA_GLOBAL_KEY, source: "default", generation: 0, fitness: null, genome: defaultOcrGenome() };
}

// ---------------------------------------------------------------------------
// ストア
// ---------------------------------------------------------------------------

/**
 * OCR 用 GA 集団ストアを生成。永続先は <root>/<key>.json、
 * 学習ログは <root>/evolution.jsonl (世代ごとの fitness 推移)。
 * best が baseline を 5 世代連続で下回ったら既定 + ランダムで再 seed する。
 */
export function createOcrGaStore(root = "app_data/training/ga"): GaStore<OcrGenome> {
  return new GaStore<OcrGenome>({
    root,
    schema: OCR_GENE_SCHEMA,
    size: 8,
    elite: 2,
    mutationRate: 0.3,
    logFile: `${root}/evolution.jsonl`,
    reseedAfterBelowBaseline: RESEED_AFTER_BELOW_BASELINE,
    // 既定値 + ランダムで初期集団を作る (既知の無難解 + 探索)。再 seed も同じ
    seed: () => [
      defaultOcrGenome(),
      ...Array.from({ length: 7 }, () => randomGenome<OcrGenome>(OCR_GENE_SCHEMA)),
    ],
  });
}

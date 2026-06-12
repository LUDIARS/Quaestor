/**
 * OCR パラメータの遺伝的最適化 — 汎用 GA エンジン (genetic.ts) の OCR 特化インスタンス。
 *
 * PaddleOCR の det/rec パラメータを遺伝子として進化させる。GA の骨格 (生成/変異/交叉/
 * 世代更新/永続) は genetic.ts に汎用化済。ここでは OCR 用の遺伝子スキーマと既定値、
 * 集団ストアの生成だけを定義する (ブラックボックス・アーキテクチャでも同じ engine を再利用)。
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

/** PaddleOCR デフォルト近傍の遺伝子 (初期集団の第 1 個体に使う) */
export function defaultOcrGenome(): OcrGenome {
  return { detThresh: 0.3, boxThresh: 0.6, unclipRatio: 1.6, limitSideLen: 960, useDilation: false, dropScore: 0.5 };
}

export type EvaluatedOcrGenome = Evaluated<OcrGenome>;

/** OCR 用 GA 集団ストアを生成。永続先は app_data/training/ga/<key>.json */
export function createOcrGaStore(root = "app_data/training/ga"): GaStore<OcrGenome> {
  return new GaStore<OcrGenome>({
    root,
    schema: OCR_GENE_SCHEMA,
    size: 8,
    elite: 2,
    mutationRate: 0.3,
    // 既定値 + ランダムで初期集団を作る (既知の無難解 + 探索)
    seed: () => [
      defaultOcrGenome(),
      ...Array.from({ length: 7 }, () => randomGenome<OcrGenome>(OCR_GENE_SCHEMA)),
    ],
  });
}

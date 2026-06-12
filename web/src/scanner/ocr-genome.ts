/**
 * OCR-GA 遺伝子 (PaddleOCR det/rec パラメータ) と sidecar 実行ヘルパー。
 * backend src/services/ocr-ga.ts の OcrGenome と形を合わせる。
 */

import { ocrSidecarUrl } from "../lib/runtime-config.js";

/** PaddleOCR det/rec パラメータ = 1 個体 */
export interface OcrGenome {
  detThresh: number;
  boxThresh: number;
  unclipRatio: number;
  limitSideLen: number;
  useDilation: boolean;
  dropScore: number;
}

/** sidecar が返す 1 行 */
export interface OcrLine {
  polygon: Array<[number, number]>;
  bbox: [number, number, number, number];
  text: string;
  score: number;
}

/**
 * 指定遺伝子で sidecar OCR を 1 回実行する。sidecar 未起動/失敗は例外。
 * baseUrl 未指定時は backend 公開設定 (/v1/config) から解決する。
 */
export async function runOcrGenome(
  imageUrl: string,
  genome: OcrGenome,
  baseUrl?: string,
): Promise<OcrLine[]> {
  const base = baseUrl ?? (await ocrSidecarUrl());
  const blob = await (await fetch(imageUrl)).blob();
  const form = new FormData();
  form.append("image", blob, "receipt.jpg");
  form.append("genome", JSON.stringify(genome));

  const res = await fetch(`${base}/detect`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`sidecar /detect ${res.status}`);
  const json = (await res.json()) as { lines?: OcrLine[] };
  return json.lines ?? [];
}

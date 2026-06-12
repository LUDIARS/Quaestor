/**
 * OCR-GA 遺伝子 (PaddleOCR det/rec パラメータ) と sidecar 実行ヘルパー。
 * backend src/services/ocr-ga.ts の OcrGenome と形を合わせる。
 */

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

function sidecarUrl(): string {
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.["VITE_OCR_SIDECAR_URL"] ?? "http://127.0.0.1:17350";
}

/**
 * 指定遺伝子で sidecar OCR を 1 回実行する。sidecar 未起動/失敗は例外。
 */
export async function runOcrGenome(
  imageUrl: string,
  genome: OcrGenome,
  baseUrl: string = sidecarUrl(),
): Promise<OcrLine[]> {
  const blob = await (await fetch(imageUrl)).blob();
  const form = new FormData();
  form.append("image", blob, "receipt.jpg");
  form.append("genome", JSON.stringify(genome));

  const res = await fetch(`${baseUrl}/detect`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`sidecar /detect ${res.status}`);
  const json = (await res.json()) as { lines?: OcrLine[] };
  return json.lines ?? [];
}

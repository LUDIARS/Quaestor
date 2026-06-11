/**
 * FieldLocatorEngine 実装群。
 *
 * FallbackFieldLocator  — heuristic 近似 (デフォルト、ゼロ依存)
 * TesseractFieldLocator — Tesseract.js word-bbox (高精度、要言語モデル DL)
 *
 * 差し替えは FieldLocatorEngine インターフェース経由。
 */

import type { DetectedRegion, FieldLocatorEngine, OcrFields } from "./types.js";
import { receiptFieldRegions, fillRegionValues } from "./receipt-engine.js";

// ---------------------------------------------------------------------------
// FallbackFieldLocator — heuristic 領域 + OCR 値充填 (位置は近似)
// ---------------------------------------------------------------------------

/**
 * レシート全体の bbox から heuristic でフィールド位置を推定する。
 * 実 pixel 座標は近似だが、ゼロ追加依存でどこでも動く。
 * TesseractFieldLocator/YoloFieldLocator が不要な場合のデフォルト。
 */
export class FallbackFieldLocator implements FieldLocatorEngine {
  async locate(
    _imageUrl: string,
    naturalWidth: number,
    naturalHeight: number,
    fields: OcrFields,
    _mode: "receipt" | "food",
  ): Promise<DetectedRegion[]> {
    const margin = 0.05;
    const candidate = {
      x: naturalWidth  * margin,
      y: naturalHeight * margin,
      width:  naturalWidth  * (1 - margin * 2),
      height: naturalHeight * (1 - margin * 2),
      score: 0.5,
      meta: emptyMeta(),
    };
    const regions = receiptFieldRegions(candidate);
    return fillRegionValues(regions, fields).map((r, i) => ({
      ...r,
      delay: i * 500,
    }));
  }
}

// ---------------------------------------------------------------------------
// TesseractFieldLocator — Tesseract.js word-level bbox
// ---------------------------------------------------------------------------

/**
 * Tesseract.js を使って実際のテキスト位置を特定する。
 * 日本語レシートには jpn+eng 言語モデルが必要 (初回 DL ~50MB)。
 *
 * 利用方法:
 *   import { TesseractFieldLocator } from "./field-locator.js";
 *   const locator = new TesseractFieldLocator("jpn+eng");
 *   // useScanPipeline の fieldLocator に渡す
 */
export class TesseractFieldLocator implements FieldLocatorEngine {
  constructor(private readonly lang: string = "jpn+eng") {}

  async locate(
    imageUrl: string,
    naturalWidth: number,
    naturalHeight: number,
    fields: OcrFields,
    mode: "receipt" | "food",
  ): Promise<DetectedRegion[]> {
    // 動的インポート — Tesseract.js は重い (tree-shake のため static import しない)
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(this.lang);
    try {
      const res = await worker.recognize(imageUrl);
      // Page type in this version omits words; cast via unknown
      const words = ((res.data as unknown) as { words: TesseractWord[] }).words ?? [];
      return buildFieldRegions(words, fields, mode, naturalWidth, naturalHeight);
    } finally {
      await worker.terminate();
    }
  }
}

// ---------------------------------------------------------------------------
// Tesseract 内部型 + マッチングロジック
// ---------------------------------------------------------------------------

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

const FIELD_COLORS = {
  payee: "#00ffc8",
  date:  "#7c8fff",
  items: "#7c8fff",
  total: "#fbbf24",
} as const;

const PAD = 4; // bbox padding (px)

function buildFieldRegions(
  words: TesseractWord[],
  fields: OcrFields,
  _mode: "receipt" | "food",
  _nw: number,
  _nh: number,
): DetectedRegion[] {
  const regions: DetectedRegion[] = [];
  let delay = 0;

  const push = (found: { x: number; y: number; width: number; height: number } | null, r: Omit<DetectedRegion, "x" | "y" | "width" | "height">) => {
    if (!found) return;
    regions.push({ ...found, ...r });
    delay += 500;
  };

  push(findText(words, fields.payee), {
    id: "payee", label: "STORE NAME",
    color: FIELD_COLORS.payee,
    value: fields.payee ?? undefined,
    confidence: 0.9, delay,
  });

  push(findText(words, fields.date), {
    id: "date", label: "DATE",
    color: FIELD_COLORS.date,
    value: fields.date ?? undefined,
    confidence: 0.85, delay,
  });

  if (fields.total != null) {
    const totalStr = fields.total.toLocaleString();
    push(findText(words, totalStr), {
      id: "total", label: "TOTAL",
      color: FIELD_COLORS.total,
      value: `¥${totalStr}`,
      confidence: 0.95, delay,
    });
    delay += 500;
  }

  if (fields.items) {
    try {
      const items = JSON.parse(fields.items) as { name: string; price: number }[];
      for (const item of items.slice(0, 4)) {
        push(findText(words, item.name), {
          id: `item-${item.name}`,
          label: "ITEM",
          color: FIELD_COLORS.items,
          value: `${item.name}  ¥${item.price.toLocaleString()}`,
          confidence: 0.8, delay,
        });
      }
    } catch { /* ignore */ }
  }

  return regions;
}

function findText(
  words: TesseractWord[],
  text: string | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!text) return null;
  const needle = normalize(text);
  let best: TesseractWord | null = null;
  let bestScore = 0;

  for (const w of words) {
    const hay = normalize(w.text);
    if (!hay) continue;
    // Jaccard-like overlap on normalized strings
    const score = overlap(needle, hay);
    if (score > bestScore && score >= 0.35) {
      bestScore = score;
      best = w;
    }
  }
  if (!best) return null;

  const { x0, y0, x1, y1 } = best.bbox;
  return {
    x:      Math.max(0, x0 - PAD),
    y:      Math.max(0, y0 - PAD),
    width:  (x1 - x0) + PAD * 2,
    height: (y1 - y0) + PAD * 2,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[¥,\s\-\/]/g, "");
}

function overlap(a: string, b: string): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return short.length / long.length;
  // common prefix ratio
  let i = 0;
  while (i < short.length && i < long.length && short[i] === long[i]) i++;
  return i / long.length;
}

function emptyMeta() {
  return {
    downscaleW: 0, downscaleH: 0, threshold: 24,
    fillRatio: 0, aspectRatio: 0, areaRatio: 0,
    parallelismScore: 0, textRowRatio: 0, ledgerRowRatio: 0,
    textRunDensity: 0, containsTotal: false, otherKeywordHits: 0,
  };
}

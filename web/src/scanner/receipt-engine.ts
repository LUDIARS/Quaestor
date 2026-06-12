/**
 * Quaestor 用 receipt 検知エンジン。
 * 既存 receipt-detector.ts (Sobel edge) を DetectionEngine インターフェースで包む。
 *
 * Memoria の food 検知は別実装 (yolo-engine.ts 等) で差し替える。
 */

import {
  detectReceiptCandidates,
  type ReceiptCandidate,
} from "../../../src/detection/receipt-detector.js";
import type { DetectedRegion, DetectionEngine, OcrFields } from "./types.js";

const REGION_COLOR_MAIN = "#00ffc8";
const REGION_COLOR_FIELD = "#7c8fff";
const REGION_COLOR_TOTAL = "#fbbf24";

/** Sobel edge detector を DetectionEngine として公開 */
export class SobelReceiptEngine implements DetectionEngine {
  async detect(
    data: Uint8ClampedArray,
    naturalWidth: number,
    naturalHeight: number,
  ): Promise<DetectedRegion[]> {
    const candidates = detectReceiptCandidates(
      data as unknown as Uint8Array,
      naturalWidth,
      naturalHeight,
    );
    const top = candidates[0];
    if (!top) return [];
    return receiptMainRegion(top);
  }
}

/** レシート全体の検知ボックス */
export function receiptMainRegion(c: ReceiptCandidate): DetectedRegion[] {
  return [
    {
      id: "receipt",
      label: "RECEIPT",
      x: c.x, y: c.y,
      width: c.width, height: c.height,
      confidence: c.score,
      color: REGION_COLOR_MAIN,
      delay: 0,
    },
  ];
}

/**
 * レシート全体の bbox からフィールド別サブ領域を推定する。
 * 典型的な日本のレシートレイアウト (店名上部 / 品目中段 / 合計下部) に基づく。
 */
export function receiptFieldRegions(c: ReceiptCandidate): DetectedRegion[] {
  const { x, y, width: w, height: h } = c;
  return [
    {
      id: "payee",
      label: "STORE NAME",
      x: x + w * 0.04, y: y + h * 0.03,
      width: w * 0.92, height: h * 0.11,
      confidence: 0.9,
      color: REGION_COLOR_MAIN,
      delay: 0,
    },
    {
      id: "date",
      label: "DATE",
      x: x + w * 0.04, y: y + h * 0.16,
      width: w * 0.55, height: h * 0.07,
      confidence: 0.85,
      color: REGION_COLOR_FIELD,
      delay: 320,
    },
    {
      id: "items",
      label: "ITEMS",
      x: x + w * 0.02, y: y + h * 0.27,
      width: w * 0.96, height: h * 0.47,
      confidence: 0.8,
      color: REGION_COLOR_FIELD,
      delay: 640,
    },
    {
      id: "total",
      label: "TOTAL",
      x: x + w * 0.28, y: y + h * 0.80,
      width: w * 0.66, height: h * 0.10,
      confidence: 0.95,
      color: REGION_COLOR_TOTAL,
      delay: 960,
    },
  ];
}

/** Phase 3: OCR 結果の値を各領域に埋める。items は個別品目に展開する。 */
export function fillRegionValues(
  regions: DetectedRegion[],
  fields: OcrFields,
): DetectedRegion[] {
  return regions.flatMap((r) => {
    switch (r.id) {
      case "payee":
        return [{ ...r, value: fields.payee ?? undefined }];
      case "date":
        return [{ ...r, value: fields.date ?? undefined }];
      case "items": {
        try {
          if (fields.items) {
            const parsed = JSON.parse(fields.items) as Array<unknown>;
            if (Array.isArray(parsed) && parsed.length > 0) {
              const maxItems = Math.min(parsed.length, 10);
              const rowH = r.height / maxItems;
              const itemH = rowH * 0.88;
              return parsed.slice(0, maxItems).map((item, i) => {
                const obj = typeof item === "object" && item !== null
                  ? (item as Record<string, unknown>) : {};
                const name = typeof obj["name"] === "string" ? obj["name"]
                  : typeof item === "string" ? item
                  : `ITEM ${String(i + 1).padStart(2, "0")}`;
                return {
                  ...r,
                  id:     `item-${i}`,
                  label:  `ITEM ${String(i + 1).padStart(2, "0")}`,
                  y:      r.y + i * rowH,
                  height: itemH,
                  value:  name,
                  kind:   "item" as const,
                  delay:  (r.delay ?? 0) + i * 120,
                };
              });
            }
          }
        } catch { /* ignore */ }
        return [{ ...r, value: undefined }];
      }
      case "total":
        return [{
          ...r,
          value: fields.total != null ? `¥${fields.total.toLocaleString()}` : undefined,
        }];
      default:
        return [r];
    }
  });
}

/** 画像 URL を canvas に描いて ImageData を得る (ブラウザ専用) */
export async function imageDataFromUrl(
  url: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: d.width, height: d.height };
}

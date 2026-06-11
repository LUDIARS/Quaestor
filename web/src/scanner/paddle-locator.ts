/**
 * PaddleFieldLocator — PaddleOCR sidecar (PP-OCRv5) を使う本命のフィールド位置特定。
 *
 * sidecar (`ocr-sidecar/`) が detection(DBNet系)+recognition で正確な polygon+text を返す。
 * その line BB を OCR 抽出フィールド (date/payee/total/items) とマッチングして
 * source="real" + recognizedText 付きの DetectedRegion にする。
 *
 * sidecar 未到達時は例外を投げる → ChainedFieldLocator が Tesseract/Fallback に退避。
 */

import type { DetectedRegion, FieldLocatorEngine, OcrFields } from "./types.js";

/** sidecar が返す 1 行の認識結果 */
interface SidecarLine {
  /** 4 点ポリゴン (画像ピクセル座標) */
  polygon: Array<[number, number]>;
  /** 外接矩形 [x, y, w, h] */
  bbox: [number, number, number, number];
  text: string;
  score: number;
}

const FIELD_COLORS = {
  payee: "#00ffc8",
  date:  "#7c8fff",
  items: "#7c8fff",
  total: "#fbbf24",
} as const;

function sidecarUrl(): string {
  // Vite 環境変数 or 既定 (同一ホストの 17350)
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.["VITE_OCR_SIDECAR_URL"] ?? "http://127.0.0.1:17350";
}

export class PaddleFieldLocator implements FieldLocatorEngine {
  constructor(private readonly baseUrl: string = sidecarUrl()) {}

  async locate(
    imageUrl: string,
    _naturalWidth: number,
    _naturalHeight: number,
    fields: OcrFields,
    _mode: "receipt" | "food",
  ): Promise<DetectedRegion[]> {
    const blob = await (await fetch(imageUrl)).blob();
    const form = new FormData();
    form.append("image", blob, "receipt.jpg");

    const res = await fetch(`${this.baseUrl}/detect`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`sidecar /detect ${res.status}`);
    const json = (await res.json()) as { lines?: SidecarLine[] };
    const lines = json.lines ?? [];
    if (lines.length === 0) throw new Error("sidecar returned no lines");

    return buildRegions(lines, fields);
  }
}

// ---------------------------------------------------------------------------
// マッチング: 認識行 ↔ OCR フィールド
// ---------------------------------------------------------------------------

function buildRegions(lines: SidecarLine[], fields: OcrFields): DetectedRegion[] {
  const regions: DetectedRegion[] = [];
  let delay = 0;

  const push = (
    line: SidecarLine | null,
    meta: { id: string; label: string; color: string; value?: string; confidence: number },
  ) => {
    if (!line) return;
    const [x, y, w, h] = line.bbox;
    regions.push({
      id: meta.id, label: meta.label, color: meta.color,
      x, y, width: w, height: h,
      confidence: meta.confidence,
      value: meta.value,
      source: "real",
      recognizedText: line.text,
      polygon: line.polygon,
      delay,
    });
    delay += 500;
  };

  push(matchLine(lines, fields.payee), {
    id: "payee", label: "STORE NAME", color: FIELD_COLORS.payee,
    value: fields.payee ?? undefined, confidence: 0.9,
  });
  push(matchLine(lines, fields.date), {
    id: "date", label: "DATE", color: FIELD_COLORS.date,
    value: fields.date ?? undefined, confidence: 0.85,
  });
  if (fields.total != null) {
    const totalStr = fields.total.toLocaleString();
    push(matchLine(lines, totalStr), {
      id: "total", label: "TOTAL", color: FIELD_COLORS.total,
      value: `¥${totalStr}`, confidence: 0.95,
    });
  }
  if (fields.items) {
    try {
      const items = JSON.parse(fields.items) as { name: string; price: number }[];
      for (const item of items.slice(0, 6)) {
        push(matchLine(lines, item.name), {
          id: `item-${item.name}`, label: "ITEM", color: FIELD_COLORS.items,
          value: `${item.name}  ¥${item.price.toLocaleString()}`, confidence: 0.8,
        });
      }
    } catch { /* ignore */ }
  }

  return regions;
}

function matchLine(lines: SidecarLine[], text: string | null): SidecarLine | null {
  if (!text) return null;
  const needle = normalize(text);
  let best: SidecarLine | null = null;
  let bestScore = 0;
  for (const l of lines) {
    const hay = normalize(l.text);
    if (!hay) continue;
    const score = overlap(needle, hay);
    if (score > bestScore && score >= 0.35) {
      bestScore = score;
      best = l;
    }
  }
  return best;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[¥,\s\-/]/g, "");
}

function overlap(a: string, b: string): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long) return 0;
  if (long.includes(short)) return short.length / long.length;
  let i = 0;
  while (i < short.length && i < long.length && short[i] === long[i]) i++;
  return i / long.length;
}

// ---------------------------------------------------------------------------
// 段階フォールバック: paddle → tesseract → fallback
// ---------------------------------------------------------------------------

/**
 * 複数の locator を順に試し、最初に空でない結果を返す。
 * sidecar 未起動 / 失敗時に自動で次段へ退避する。
 */
export class ChainedFieldLocator implements FieldLocatorEngine {
  constructor(private readonly chain: FieldLocatorEngine[]) {}

  async locate(
    imageUrl: string,
    nw: number,
    nh: number,
    fields: OcrFields,
    mode: "receipt" | "food",
  ): Promise<DetectedRegion[]> {
    for (const engine of this.chain) {
      try {
        const out = await engine.locate(imageUrl, nw, nh, fields, mode);
        if (out.length > 0) return out;
      } catch {
        /* 次段へ */
      }
    }
    return [];
  }
}

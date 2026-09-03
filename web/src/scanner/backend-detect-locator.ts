/**
 * BackendDetectFieldLocator — 撮影時の本物 BB を **backend 経由** で取る locator。
 *
 * 旧 `PaddleFieldLocator` はブラウザから sidecar (`http://127.0.0.1:17350`) を直叩きしていたが、
 * 実運用は公開面 (Cloudflare Tunnel / HTTPS、スマホ) なので 127.0.0.1 に届かず、mixed content でも
 * 遮断され、本物 BB が一度も出ていなかった。ここでは backend の
 * `POST /v1/receipts/:id/detect` を呼ぶ (勝ち遺伝子の解決・sidecar 呼び出し・採点・
 * 学習レコード保存はすべて backend の責務)。
 *
 * 演出は待たせない: backend の 1 回の検出は CPU で 40 秒かかるので、こちらは短い timeout で
 * 打ち切って次段 (Tesseract → 比率推定) に譲る。打ち切っても backend 側の評価は最後まで走り、
 * 運用評価レコードは後から発行される (spec/feature/scanner-overlay.md §1 の大原則)。
 */

import type { DetectedRegion, FieldLocatorEngine, OcrFields } from "./types.js";

/**
 * backend detect を待つ上限。use-scan-pipeline の LOCATE_TIMEOUT_MS (6s) より短くして、
 * 時間切れでも同じ locate の中で Tesseract / 比率推定へ落ちられるようにする。
 */
export const BACKEND_DETECT_TIMEOUT_MS = 3500;

/** backend が返す 1 領域 (src/services/receipt-detect/types.ts の DetectedFieldRegion) */
interface BackendRegion {
  field: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  recognizedText: string;
  polygon: Array<[number, number]>;
}

interface BackendDetectResponse {
  source: "real" | null;
  regions?: BackendRegion[];
}

const FIELD_COLORS = {
  payee: "#00ffc8",
  date:  "#7c8fff",
  items: "#7c8fff",
  total: "#fbbf24",
} as const;

export class BackendDetectFieldLocator implements FieldLocatorEngine {
  constructor(
    private readonly receiptId: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = BACKEND_DETECT_TIMEOUT_MS,
  ) {}

  async locate(
    _imageUrl: string,
    _naturalWidth: number,
    _naturalHeight: number,
    fields: OcrFields,
    _mode: "receipt" | "food",
  ): Promise<DetectedRegion[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`/v1/receipts/${encodeURIComponent(this.receiptId)}/detect`, {
        method: "POST",
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`backend /detect ${res.status}`);
      const json = (await res.json()) as BackendDetectResponse;
      if (json.source !== "real") return [];
      return toRegions(json.regions ?? [], fields);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * backend の領域を演出用 DetectedRegion にする。
 * 学習データ化は backend が済ませているので persisted を立てて再送を防ぐ。
 */
export function toRegions(regions: BackendRegion[], fields: OcrFields): DetectedRegion[] {
  const items = parseItems(fields.items);
  let delay = 0;
  return regions.map((r) => {
    const meta = displayFor(r.field, fields, items);
    const region: DetectedRegion = {
      id: r.field,
      label: meta.label,
      color: meta.color,
      x: r.x, y: r.y, width: r.width, height: r.height,
      confidence: r.confidence,
      value: meta.value,
      source: "real",
      recognizedText: r.recognizedText,
      polygon: r.polygon,
      persisted: true,
      delay,
    };
    delay += 850;
    return region;
  });
}

interface ReceiptItem { name: string; price: number }

function displayFor(
  field: string,
  fields: OcrFields,
  items: ReceiptItem[],
): { label: string; color: string; value?: string } {
  if (field === "payee") {
    return { label: "STORE NAME", color: FIELD_COLORS.payee, value: fields.payee ?? undefined };
  }
  if (field === "date") {
    return { label: "DATE", color: FIELD_COLORS.date, value: fields.date ?? undefined };
  }
  if (field === "total") {
    return {
      label: "TOTAL",
      color: FIELD_COLORS.total,
      value: fields.total != null ? `¥${fields.total.toLocaleString()}` : undefined,
    };
  }
  const item = items[itemIndex(field)];
  return {
    label: "ITEM",
    color: FIELD_COLORS.items,
    value: item ? `${item.name}  ¥${item.price.toLocaleString()}` : undefined,
  };
}

/** backend の item ラベルは `item-<0 始まりの添字>` */
function itemIndex(field: string): number {
  const n = Number(field.replace(/^item-/, ""));
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

function parseItems(items: string | null): ReceiptItem[] {
  if (!items) return [];
  try {
    const parsed = JSON.parse(items) as ReceiptItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

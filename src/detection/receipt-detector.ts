/**
 * レシート検出器 — 純粋な ImageData → 矩形候補。
 *
 * Browser の Canvas / Node の Buffer 双方から呼べるよう、 Uint8Array (RGBA) と
 * 幅・高さを受け取る純関数構成にする。
 *
 * パイプライン:
 *   1. 入力 (RGBA, 任意解像度)
 *   2. 縮小 (既定 128x256 程度) — 計算量を毎フレーム ms 級に抑える
 *   3. グレースケール変換 (Rec.601 加重)
 *   4. Otsu 閾値による二値化 (白 / 黒)
 *   5. 4-連結 flood fill で「白」連結成分を抽出
 *   6. 各成分の bounding box + 占有率 + アスペクト比 で receipt らしさを scoring
 *   7. 最大成分のうち threshold 超のものを返す
 *
 * 入力座標系 (元画像のピクセル) で結果を返すので、 呼び出し側は HD 画像でも縮小無しで使える。
 */

export interface ReceiptCandidate {
  /** 元画像座標系での矩形 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1, 高いほど receipt 確度が高い */
  score: number;
  /** 検出に使った縮小画像での内部値 (debug 用) */
  meta: {
    downscaleW: number;
    downscaleH: number;
    threshold: number;
    fillRatio: number;
    aspectRatio: number;
    areaRatio: number;
  };
}

export interface DetectorOptions {
  /** 縮小後の最大辺 (px)。 既定 256。 これより大きいなら縮める */
  maxDim?: number;
  /** 矩形候補の min 占有率 (元画像) */
  minAreaRatio?: number;
  /** 縦横比の許容範囲 (height/width)。 receipt は縦長想定だが完全縦でなくてよい */
  aspectMin?: number;
  aspectMax?: number;
  /** 連結成分内の bbox-fill 比率 min (矩形性) */
  minFillRatio?: number;
  /** 上位何件返すか */
  topK?: number;
  /** デバッグ用: 二値化 mask と縮小寸法を結果に同梱する */
  returnDebug?: boolean;
}

export interface DetectorDebug {
  /** 縮小グレースケール画像 (length = w*h) */
  gray: Uint8Array;
  /** 二値化結果。 0=黒 / 1=白 (元) ですが flood fill 後は 2 (visited) になっている部分も含む */
  mask: Uint8Array;
  /** 縮小幅・高さ (px) */
  width: number;
  height: number;
  /** Otsu 閾値 */
  threshold: number;
}

export interface DetectionResult {
  candidates: ReceiptCandidate[];
  debug?: DetectorDebug;
}

export const DEFAULTS: Required<Omit<DetectorOptions, "returnDebug">> = {
  maxDim: 256,
  minAreaRatio: 0.04,    // 元画像面積の 4% 以上
  aspectMin: 0.25,       // 横長 (1:4) ~ 縦長 (4:1) を許容
  aspectMax: 4.0,
  minFillRatio: 0.6,     // 連結成分の bbox 充填率 60% 以上 = ほぼ矩形
  topK: 3,
};

/**
 * RGBA pixel array (length = w*h*4) からレシート候補を返す。
 * RGBA は ImageData.data 互換。 Uint8Array / Uint8ClampedArray どちらも可。
 */
export function detectReceiptCandidates(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: DetectorOptions = {},
): ReceiptCandidate[] {
  const o = { ...DEFAULTS, ...opts };
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba length ${rgba.length} != ${width}*${height}*4`);
  }

  // 1. 縮小スケール決定
  const scale = Math.min(1, o.maxDim / Math.max(width, height));
  const dw = Math.max(8, Math.round(width * scale));
  const dh = Math.max(8, Math.round(height * scale));

  // 2-3. Nearest neighbor で縮小 + グレースケール化
  const gray = new Uint8Array(dw * dh);
  const sx = width / dw;
  const sy = height / dh;
  for (let y = 0; y < dh; y++) {
    const srcY = Math.floor(y * sy);
    for (let x = 0; x < dw; x++) {
      const srcX = Math.floor(x * sx);
      const i = (srcY * width + srcX) * 4;
      // Rec.601 加重輝度
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      gray[y * dw + x] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    }
  }

  // 4. Otsu 閾値
  const threshold = otsu(gray);
  const mask = new Uint8Array(dw * dh);
  for (let i = 0; i < gray.length; i++) {
    mask[i] = gray[i]! >= threshold ? 1 : 0;
  }

  // 5. 連結成分 flood fill (4-連結)
  const components = floodFill4(mask, dw, dh);

  // 6-7. scoring + filter
  const candidates: ReceiptCandidate[] = [];
  const totalArea = width * height;
  for (const c of components) {
    const compW = c.maxX - c.minX + 1;
    const compH = c.maxY - c.minY + 1;
    const fillRatio = c.area / (compW * compH);
    const aspectRatio = compH / compW;
    // 縮小座標 → 元画像座標
    const x = Math.round(c.minX / scale);
    const y = Math.round(c.minY / scale);
    const ww = Math.round(compW / scale);
    const hh = Math.round(compH / scale);
    const areaRatio = (ww * hh) / totalArea;

    if (areaRatio < o.minAreaRatio) continue;
    if (aspectRatio < o.aspectMin || aspectRatio > o.aspectMax) continue;
    if (fillRatio < o.minFillRatio) continue;

    // score = 占有率 × 矩形性 × 中心バイアス
    const cx = (c.minX + c.maxX) / 2 / dw;
    const cy = (c.minY + c.maxY) / 2 / dh;
    const centerness = 1 - Math.hypot(cx - 0.5, cy - 0.5);
    const score = clamp01(0.5 * fillRatio + 0.3 * centerness + 0.2 * Math.min(1, areaRatio * 4));

    candidates.push({
      x, y, width: ww, height: hh, score,
      meta: { downscaleW: dw, downscaleH: dh, threshold, fillRatio, aspectRatio, areaRatio },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, o.topK);

  if (o.returnDebug) {
    // mask の値: 0 / 1 / 2 (visited)。 表示用には 0 / 255 に正規化したコピーが欲しいが、
    // 計算量を抑えるため呼び出し側で必要なら変換する。
    return Object.assign(top, { __debug: { gray, mask, width: dw, height: dh, threshold } as DetectorDebug });
  }
  return top;
}

/** debug 同梱結果から mask + meta を取り出すヘルパ */
export function extractDebug(candidates: ReceiptCandidate[] & { __debug?: DetectorDebug }): DetectorDebug | undefined {
  return candidates.__debug;
}

/** Otsu's method — 256-bin histogram から自動閾値を計算 */
function otsu(gray: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let varMax = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    // 同値変分のときは threshold を後ろに伸ばす — 偏った histogram (bg majority + small bright) で
    // 最初のヒット (= 背景色そのもの) を threshold にしないため
    if (v >= varMax) { varMax = v; threshold = t; }
  }
  return threshold;
}

interface Component {
  area: number;
  minX: number; maxX: number;
  minY: number; maxY: number;
}

/**
 * 値=1 のピクセルを 4-連結で flood fill。 各成分の bbox + area を返す。
 * mask は破壊変更される (探索済みは 2 にする)。
 */
function floodFill4(mask: Uint8Array, w: number, h: number): Component[] {
  const out: Component[] = [];
  const stack: number[] = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      if (mask[y0 * w + x0] !== 1) continue;
      let area = 0, minX = x0, maxX = x0, minY = y0, maxY = y0;
      stack.push(x0, y0);
      while (stack.length > 0) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        const idx = y * w + x;
        if (mask[idx] !== 1) continue;
        mask[idx] = 2;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x + 1 < w) stack.push(x + 1, y);
        if (x > 0) stack.push(x - 1, y);
        if (y + 1 < h) stack.push(x, y + 1);
        if (y > 0) stack.push(x, y - 1);
      }
      out.push({ area, minX, maxX, minY, maxY });
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 候補が複数フレーム連続して安定したかチェックするための簡易 tracker。
 * 「同じ位置 (IoU > 0.6) の高 score 候補が N フレーム連続したら確定」というロジックに使う。
 */
export class StableDetectionTracker {
  private history: ReceiptCandidate[] = [];
  constructor(
    private readonly required: number = 5,
    private readonly minIoU: number = 0.6,
    private readonly minScore: number = 0.55,
  ) {}

  push(c: ReceiptCandidate | null): { stable: boolean; candidate: ReceiptCandidate | null } {
    if (!c || c.score < this.minScore) {
      this.history = [];
      return { stable: false, candidate: null };
    }
    if (this.history.length === 0) {
      this.history.push(c);
      return { stable: false, candidate: c };
    }
    const last = this.history[this.history.length - 1]!;
    if (iou(c, last) < this.minIoU) {
      this.history = [c];
      return { stable: false, candidate: c };
    }
    this.history.push(c);
    if (this.history.length >= this.required) {
      // 平均位置で返す
      const avg = averageRect(this.history);
      this.history = [];
      return { stable: true, candidate: avg };
    }
    return { stable: false, candidate: c };
  }
}

function iou(a: ReceiptCandidate, b: ReceiptCandidate): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function averageRect(rects: ReceiptCandidate[]): ReceiptCandidate {
  const n = rects.length;
  let x = 0, y = 0, w = 0, h = 0, s = 0;
  for (const r of rects) { x += r.x; y += r.y; w += r.width; h += r.height; s += r.score; }
  const meta = rects[rects.length - 1]!.meta;
  return {
    x: Math.round(x / n), y: Math.round(y / n),
    width: Math.round(w / n), height: Math.round(h / n),
    score: s / n,
    meta,
  };
}

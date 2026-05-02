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
    /** 0..1、 1 = 左右エッジが完全に縦平行 (低い分散) */
    parallelismScore: number;
    /** 0..1、 候補内に text-like row (横線文字列の痕跡) が占める割合 */
    textRowRatio: number;
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
  /**
   * 白判定の固定閾値 (0..255)。 指定時は Otsu を使わず R/G/B が全部 this 以上のピクセルを「白」 にする。
   * レシートは大体白いので、 適応閾値 (Otsu) より固定閾値の方が安定して取れることが多い。
   * Scan UI 側で 1 秒毎に -1 する想定 (初期値 234)。
   */
  whiteThreshold?: number;
  /** 平行性 (左右エッジ分散) の最低値。 既定 0.3 */
  minParallelism?: number;
}

export interface DetectorDebug {
  /** 縮小グレースケール画像 (length = w*h) */
  gray: Uint8Array;
  /** 二値化結果。 0=黒 / 1=白 (元) ですが flood fill 後は 2 (visited) になっている部分も含む */
  mask: Uint8Array;
  /** 行ごとの text-like flag (0/1)。 length=h。 receipt 特有の横線文字列 row */
  textRows: Uint8Array;
  /** 縮小幅・高さ (px) */
  width: number;
  height: number;
  /** 白判定 / Otsu 閾値 */
  threshold: number;
}

export interface DetectionResult {
  candidates: ReceiptCandidate[];
  debug?: DetectorDebug;
}

export const DEFAULTS: Required<Omit<DetectorOptions, "returnDebug" | "whiteThreshold">> = {
  maxDim: 256,
  minAreaRatio: 0.04,    // 元画像面積の 4% 以上
  aspectMin: 0.25,       // 横長 (1:4) ~ 縦長 (4:1) を許容
  aspectMax: 4.0,
  minFillRatio: 0.6,     // 連結成分の bbox 充填率 60% 以上 = ほぼ矩形
  topK: 3,
  minParallelism: 0.3,
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

  // 2. Nearest neighbor で縮小 + グレースケール化 + RGB ベース白判定 mask 同時生成
  const gray = new Uint8Array(dw * dh);
  const mask = new Uint8Array(dw * dh);
  const useWhite = typeof opts.whiteThreshold === "number";
  const wT = opts.whiteThreshold ?? 0;
  const sx = width / dw;
  const sy = height / dh;
  for (let y = 0; y < dh; y++) {
    const srcY = Math.floor(y * sy);
    for (let x = 0; x < dw; x++) {
      const srcX = Math.floor(x * sx);
      const i = (srcY * width + srcX) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      gray[y * dw + x] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
      if (useWhite) {
        mask[y * dw + x] = (r >= wT && g >= wT && b >= wT) ? 1 : 0;
      }
    }
  }

  // 3. mask 確定: whiteThreshold 指定時はもう生成済、 そうでなければ Otsu
  let threshold: number;
  if (useWhite) {
    threshold = wT;
  } else {
    threshold = otsu(gray);
    for (let i = 0; i < gray.length; i++) {
      mask[i] = gray[i]! >= threshold ? 1 : 0;
    }
  }

  // 4.5. Text-row 検出 (レシート特化): 横方向の白↔暗 transition 多 + 暗ピクセル割合中位 = 文字行
  // flood fill 前に mask snapshot を取って計算する (flood fill は mask=2 で値を上書きしてしまう)
  const maskSnapshot = new Uint8Array(mask);
  const textRows = computeTextRows(maskSnapshot, dw, dh);

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

    // 平行性チェック: 左右エッジの x 座標 (各 row の最 left/right の visited pixel)
    // の std-dev が小さいほど縦平行 → score 高い
    const parallelism = parallelismScore(mask, dw, c);
    if (parallelism < o.minParallelism) continue;

    // 長レシート救済: 上 or 下が画像端に触れていて (=見切れ)、 左右が平行 (>0.6) なら
    // aspectMax を 12.0 まで緩める。 とにかく縦長で平行な四角は receipt 扱いにする。
    const cutOffVertical = c.touchesTop || c.touchesBottom;
    const longReceiptOk = cutOffVertical && parallelism > 0.6;
    const aspectMaxEffective = longReceiptOk ? 12.0 : o.aspectMax;
    if (aspectRatio < o.aspectMin || aspectRatio > aspectMaxEffective) continue;
    if (fillRatio < o.minFillRatio) continue;

    // text-row 比率: 候補内に「文字行らしい横ストリーク」がどれくらい占めるか
    const textRatio = textRowsInBbox(textRows, c);

    // score = fillRatio + parallelism + textRatio + center + areaRatio
    const cx = (c.minX + c.maxX) / 2 / dw;
    const cy = (c.minY + c.maxY) / 2 / dh;
    const centerness = 1 - Math.hypot(cx - 0.5, cy - 0.5);
    // aspect bias: receipt は縦長 (1.5..4.0) を強く好む
    // 長レシート救済時は 4.0+ でも 0.9 を返す (縦長 + 見切れ + 平行 はむしろ典型的レシート)
    const aspectBias = aspectRatio >= 1.5 && aspectRatio <= 4.0 ? 1
      : longReceiptOk && aspectRatio > 4.0 ? 0.9
      : aspectRatio > 1 ? 0.6
      : 0.3;

    const score = clamp01(
      0.25 * fillRatio +
      0.20 * parallelism +
      0.25 * textRatio +
      0.15 * aspectBias +
      0.10 * centerness +
      0.05 * Math.min(1, areaRatio * 4),
    );

    candidates.push({
      x, y, width: ww, height: hh, score,
      meta: {
        downscaleW: dw, downscaleH: dh, threshold,
        fillRatio, aspectRatio, areaRatio,
        parallelismScore: parallelism,
        textRowRatio: textRatio,
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, o.topK);

  if (opts.returnDebug) {
    return Object.assign(top, {
      __debug: { gray, mask, textRows, width: dw, height: dh, threshold } as DetectorDebug,
    });
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
  /** 連結成分が画像端に触れているか (見切れ判定用) */
  touchesTop: boolean;
  touchesBottom: boolean;
  touchesLeft: boolean;
  touchesRight: boolean;
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
      out.push({
        area, minX, maxX, minY, maxY,
        touchesTop: minY === 0,
        touchesBottom: maxY === h - 1,
        touchesLeft: minX === 0,
        touchesRight: maxX === w - 1,
      });
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 行ごとに 「receipt の文字行 (text-like row)」 か判定して 0/1 を返す。
 * receipt の特徴: 1 行に 4+ 回の白↔暗 遷移、 暗ピクセル比率 5-50%。
 * これを満たす行が候補内に多いほど、 ただの白ボックスではなく「文字が並んだレシート」 と推定できる。
 */
function computeTextRows(mask: Uint8Array, w: number, h: number): Uint8Array {
  const rows = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let transitions = 0;
    let dark = 0;
    let prev = mask[y * w] ?? 0;
    if (prev === 0) dark++;
    for (let x = 1; x < w; x++) {
      const v = mask[y * w + x] ?? 0;
      if (v !== prev) transitions++;
      if (v === 0) dark++;
      prev = v;
    }
    const ratio = dark / w;
    if (transitions >= 4 && ratio >= 0.05 && ratio <= 0.5) {
      rows[y] = 1;
    }
  }
  return rows;
}

/**
 * 候補連結成分の bbox 範囲内で text-like row が占める比率。
 */
function textRowsInBbox(textRows: Uint8Array, c: Component): number {
  let count = 0;
  for (let y = c.minY; y <= c.maxY; y++) {
    if (textRows[y] === 1) count++;
  }
  const h = c.maxY - c.minY + 1;
  return h > 0 ? count / h : 0;
}

/**
 * 連結成分の左右エッジ x 座標を行ごとに取得 → 標準偏差 (相対) で平行性を測る。
 * 完全な縦平行な矩形なら left/right が定数 → std-dev=0 → score=1。
 */
function parallelismScore(mask: Uint8Array, w: number, c: Component): number {
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let y = c.minY; y <= c.maxY; y++) {
    let l = -1, r = -1;
    for (let x = c.minX; x <= c.maxX; x++) {
      if (mask[y * w + x] === 2) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) { lefts.push(l); rights.push(r); }
  }
  if (lefts.length < 4) return 0;
  const sd = (arr: number[]) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return Math.sqrt(v);
  };
  const compW = c.maxX - c.minX + 1;
  // sd を component 幅で正規化 → 0 が完全平行、 0.3+ で大きく揺れている
  const left = sd(lefts) / compW;
  const right = sd(rights) / compW;
  const avg = (left + right) / 2;
  return clamp01(1 - avg * 4); // 0.25 の sd で 0 にする調整
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

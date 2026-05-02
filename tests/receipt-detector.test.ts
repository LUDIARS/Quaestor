import { describe, it, expect } from "vitest";
import {
  detectReceiptCandidates,
  StableDetectionTracker,
  type ReceiptCandidate,
} from "../src/detection/receipt-detector.js";

/**
 * 合成画像生成ヘルパ。 RGBA Uint8Array を返す。
 */
function blank(w: number, h: number, fill: number = 30): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = fill;
    buf[i * 4 + 1] = fill;
    buf[i * 4 + 2] = fill;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function fillRect(rgba: Uint8Array, w: number, _h: number, rx: number, ry: number, rw: number, rh: number, value: number) {
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
}

describe("detectReceiptCandidates", () => {
  it("finds a single white receipt on dark background", () => {
    const W = 640, H = 480;
    const rgba = blank(W, H, 30);
    // 中央近くに縦長の白矩形 (160x320)
    fillRect(rgba, W, H, 240, 80, 160, 320, 235);

    const cands = detectReceiptCandidates(rgba, W, H);
    expect(cands.length).toBeGreaterThan(0);
    const top = cands[0]!;
    // bbox は元画像座標で返るはず
    expect(top.x).toBeGreaterThanOrEqual(220);
    expect(top.x).toBeLessThanOrEqual(260);
    expect(top.width).toBeGreaterThanOrEqual(140);
    expect(top.width).toBeLessThanOrEqual(180);
    // text/ledger row 0% でも fill + parallelism + aspect bias で 0.4 以上は出る
    expect(top.score).toBeGreaterThan(0.4);
  });

  it("rejects pure noise (no large rectangle)", () => {
    const W = 320, H = 240;
    const rgba = new Uint8Array(W * H * 4);
    // ランダム輝度のノイズ
    let s = 1;
    for (let i = 0; i < W * H; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = s & 0xff;
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    const cands = detectReceiptCandidates(rgba, W, H);
    // ノイズだと矩形性 (fillRatio) で弾かれて 0 か、 出ても score 低
    if (cands.length > 0) expect(cands[0]!.score).toBeLessThan(0.7);
  });

  it("returns empty for too-small bright region (below minAreaRatio)", () => {
    const W = 640, H = 480;
    const rgba = blank(W, H, 30);
    // 30x30 の小さな白ブロックは 0.3% 程度 → minAreaRatio (4%) 未満
    fillRect(rgba, W, H, 100, 100, 30, 30, 240);
    const cands = detectReceiptCandidates(rgba, W, H);
    expect(cands).toHaveLength(0);
  });

  it("respects topK", () => {
    const W = 640, H = 480;
    const rgba = blank(W, H, 30);
    fillRect(rgba, W, H, 50, 50, 150, 300, 240);
    fillRect(rgba, W, H, 350, 50, 150, 300, 200);
    const cands = detectReceiptCandidates(rgba, W, H, { topK: 1 });
    expect(cands).toHaveLength(1);
  });

  it("filters out non-rectangular shapes via minFillRatio", () => {
    // L 字型の白領域 → bbox の 50% 以下しか埋まってない → 弾かれる
    const W = 640, H = 480;
    const rgba = blank(W, H, 30);
    fillRect(rgba, W, H, 200, 100, 80, 280, 240);
    fillRect(rgba, W, H, 200, 320, 240, 60, 240);
    const cands = detectReceiptCandidates(rgba, W, H, { minFillRatio: 0.7 });
    // L 字は fillRatio < 0.7 なので 0 件のはず (ノイズ等で出ても score 低)
    if (cands.length > 0) expect(cands[0]!.meta.fillRatio).toBeGreaterThanOrEqual(0.7);
  });
});

describe("StableDetectionTracker", () => {
  function rect(x: number, y: number, w: number, h: number, score = 0.7): ReceiptCandidate {
    return {
      x, y, width: w, height: h, score,
      meta: { downscaleW: 128, downscaleH: 256, threshold: 127, fillRatio: 0.9, aspectRatio: 2, areaRatio: 0.2 },
    };
  }

  it("stabilizes after N consecutive matching frames", () => {
    const t = new StableDetectionTracker(3, 0.5, 0.5);
    expect(t.push(rect(100, 100, 200, 400)).stable).toBe(false);
    expect(t.push(rect(102, 102, 200, 400)).stable).toBe(false);
    const r = t.push(rect(98, 98, 200, 400));
    expect(r.stable).toBe(true);
    expect(r.candidate).not.toBeNull();
  });

  it("resets on score drop", () => {
    const t = new StableDetectionTracker(3, 0.5, 0.5);
    t.push(rect(100, 100, 200, 400));
    t.push(rect(100, 100, 200, 400));
    t.push(null);    // score drop
    const r = t.push(rect(100, 100, 200, 400));
    expect(r.stable).toBe(false);
  });

  it("resets on big position jump (low IoU)", () => {
    const t = new StableDetectionTracker(3, 0.5, 0.5);
    t.push(rect(100, 100, 200, 400));
    t.push(rect(100, 100, 200, 400));
    // 全く違う位置 → IoU 0
    const r = t.push(rect(500, 0, 50, 50));
    expect(r.stable).toBe(false);
  });
});

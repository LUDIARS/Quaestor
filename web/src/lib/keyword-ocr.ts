/**
 * Tesseract.js を Web Worker で走らせて、 レシート系キーワード (合計 / 小計 / 領収 / レシート) の
 * bbox を取り出す。
 *
 * 主目的:
 *   - 受領書を「合計」 という文字を含む 連結 edge component で同定する
 *   - 全文 OCR は重い (1-3s) ので、 1.5-2 秒に 1 回だけ実行
 *   - 解像度 1/4 (= scan の low-res 256x144 等) を流すので元 HD より速い
 */

import { createWorker, type Worker } from "tesseract.js";

const KEYWORDS = ["合計", "小計", "領収", "レシート", "Total", "Subtotal"];

export interface KeywordHit {
  keyword: string;
  /** 元画像座標 (= 渡した ImageData の座標系) */
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export class KeywordOcr {
  private worker: Worker | null = null;
  private busy = false;
  private initPromise: Promise<void> | null = null;

  async ensureReady(progressCb?: (msg: string, pct: number) => void): Promise<void> {
    if (this.worker) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const w = await createWorker(["jpn", "eng"], 1, {
        logger: (m: { status: string; progress: number }) => {
          progressCb?.(m.status, m.progress);
        },
      });
      this.worker = w;
    })();
    await this.initPromise;
  }

  /**
   * ImageData を OCR して keyword hits を抽出。
   * 同時実行不可 (busy 中は null を返す)。
   */
  async detect(imgData: ImageData): Promise<KeywordHit[] | null> {
    if (!this.worker) return null;
    if (this.busy) return null;
    this.busy = true;
    try {
      // ImageData → canvas → blob (tesseract が読める形式)
      const cv = document.createElement("canvas");
      cv.width = imgData.width;
      cv.height = imgData.height;
      cv.getContext("2d")?.putImageData(imgData, 0, 0);
      const blob: Blob | null = await new Promise((res) => cv.toBlob((b) => res(b), "image/png"));
      if (!blob) return [];
      const result = await this.worker.recognize(blob, {}, { blocks: true });
      const hits: KeywordHit[] = [];
      // tesseract v5 の結果から block→paragraph→line→word を辿って bbox 取り出し
      type WordBox = { text: string; bbox?: { x0: number; y0: number; x1: number; y1: number }; confidence?: number };
      type Para = { lines?: Array<{ words?: WordBox[] }> };
      type Block = { paragraphs?: Para[] };
      const blocks: Block[] = (result.data as unknown as { blocks?: Block[] }).blocks ?? [];
      for (const blk of blocks) {
        for (const par of blk.paragraphs ?? []) {
          for (const line of par.lines ?? []) {
            const text = (line.words ?? []).map((w) => w.text ?? "").join("");
            for (const kw of KEYWORDS) {
              if (text.includes(kw)) {
                // 行 bbox を line から取りたいが API が無いので words の和集合で代用
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                let conf = 0;
                let n = 0;
                for (const wd of line.words ?? []) {
                  const b = wd.bbox;
                  if (!b) continue;
                  x0 = Math.min(x0, b.x0);
                  y0 = Math.min(y0, b.y0);
                  x1 = Math.max(x1, b.x1);
                  y1 = Math.max(y1, b.y1);
                  conf += wd.confidence ?? 0;
                  n++;
                }
                if (n === 0 || !Number.isFinite(x0)) continue;
                hits.push({
                  keyword: kw,
                  x: x0,
                  y: y0,
                  w: x1 - x0,
                  h: y1 - y0,
                  conf: conf / n / 100,
                });
              }
            }
          }
        }
      }
      return hits;
    } finally {
      this.busy = false;
    }
  }

  isBusy(): boolean { return this.busy; }
  isReady(): boolean { return this.worker !== null; }

  async terminate(): Promise<void> {
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      await w.terminate();
    }
  }
}

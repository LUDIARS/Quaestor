/**
 * 検出 BB 学習データセット writer / exporter。
 *
 * シャッター後の confirm フェーズで得た「本物 BB (source=real) + 認識テキスト」を
 * ブラックボックス学習用に永続化する (spec/feature/scanner-overlay.md §3)。
 *
 *  - 追記ログ: <root>/regions.jsonl       … 1 行 1 レコード (監査・ストリーム用)
 *  - 個別:     <root>/records/<id>.json   … receipt 単位の最新スナップショット
 *  - YOLO:     exportYolo() で画像コピー + 正規化ラベル txt を出力 (C の学習に使う)
 *
 * 個人データ規約: app_data 配下に置き git に出さない。画像は ReceiptStorage 参照のみ。
 */

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ReceiptStorage } from "./receipt-storage.js";

/** 学習に保存する 1 領域 (本物 BB のみ) */
export interface TrainingRegion {
  /** フィールド種別 (payee/date/items/total/item-* …)。YOLO class はこの label から決まる */
  label: string;
  /** 実ピクセル BB (naturalWidth/Height 座標系) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** OCR が読んだ生テキスト (学習ラベル) */
  text?: string;
  /** 4 点ポリゴン (回転対応、任意) */
  polygon?: Array<[number, number]>;
  confidence?: number;
}

export interface TrainingRecord {
  receiptId: string;
  /** ReceiptStorage 上の相対 path (画像参照) */
  imageRef: string | null;
  naturalWidth: number;
  naturalHeight: number;
  /** 検出に使ったエンジン (paddle / tesseract / …) */
  engine: string;
  regions: TrainingRegion[];
  /** 記録時刻 (unix sec)。呼び出し側で付与 */
  ts: number;
  /** 差分評価 (detection-eval の DetectionDiff)。毎回付与 */
  diff?: unknown;
  /** 差分がある時に Opus が類推した検出挙動指標 (DiffInference)。任意 */
  evaluation?: unknown;
}

/** YOLO class id 割当 (フィールド種別 → class)。item-* は items に寄せる */
const YOLO_CLASSES = ["payee", "date", "items", "total"] as const;

function classIdFor(label: string): number {
  const id = label.replace(/^item-.*/, "items").toLowerCase();
  const idx = (YOLO_CLASSES as readonly string[]).indexOf(id);
  return idx >= 0 ? idx : YOLO_CLASSES.length; // 未知は末尾 class
}

export class TrainingDataset {
  private readonly root: string;
  private readonly recordsDir: string;
  private readonly jsonl: string;

  constructor(root = "app_data/training/receipts", private readonly storage?: ReceiptStorage) {
    this.root = resolve(root);
    this.recordsDir = join(this.root, "records");
    this.jsonl = join(this.root, "regions.jsonl");
    mkdirSync(this.recordsDir, { recursive: true });
  }

  /** confirm フェーズの本物 BB を追記 + 個別スナップショット更新。 */
  append(record: TrainingRecord): void {
    if (record.regions.length === 0) return;
    appendFileSync(this.jsonl, JSON.stringify(record) + "\n", "utf8");
    writeFileSync(
      join(this.recordsDir, `${record.receiptId}.json`),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  /**
   * 既存レコードに差分評価 (+任意で Opus 類推) を後付けする。
   * record json を上書き + evals.jsonl に追記。レコードが無ければ何もしない。
   */
  attachEval(receiptId: string, diff: unknown, evaluation?: unknown): void {
    const path = join(this.recordsDir, `${receiptId}.json`);
    if (!existsSync(path)) return;
    const rec = JSON.parse(readFileSync(path, "utf8")) as TrainingRecord;
    rec.diff = diff;
    if (evaluation !== undefined) rec.evaluation = evaluation;
    writeFileSync(path, JSON.stringify(rec, null, 2), "utf8");
    appendFileSync(
      join(this.root, "evals.jsonl"),
      JSON.stringify({ receiptId, ts: rec.ts, engine: rec.engine, diff, evaluation }) + "\n",
      "utf8",
    );
  }

  /** 蓄積済レコード件数 (records/*.json の数)。 */
  count(): number {
    if (!existsSync(this.recordsDir)) return 0;
    return readdirSync(this.recordsDir).filter((f) => f.endsWith(".json")).length;
  }

  /**
   * YOLO 形式エクスポート。
   *   <outDir>/images/<id>.jpg
   *   <outDir>/labels/<id>.txt   … "<class> <cx> <cy> <w> <h>" (0..1 正規化)
   *   <outDir>/classes.txt
   * storage が無い (画像コピー不可) 場合はラベルのみ出力。
   * @returns 出力した receipt 件数
   */
  exportYolo(outDir = join(this.root, "yolo")): number {
    const imagesDir = join(outDir, "images");
    const labelsDir = join(outDir, "labels");
    mkdirSync(imagesDir, { recursive: true });
    mkdirSync(labelsDir, { recursive: true });
    writeFileSync(join(outDir, "classes.txt"), YOLO_CLASSES.join("\n") + "\nother\n", "utf8");

    if (!existsSync(this.recordsDir)) return 0;
    let n = 0;
    for (const file of readdirSync(this.recordsDir)) {
      if (!file.endsWith(".json")) continue;
      const rec = JSON.parse(readFileSync(join(this.recordsDir, file), "utf8")) as TrainingRecord;
      if (rec.naturalWidth <= 0 || rec.naturalHeight <= 0) continue;

      const lines = rec.regions.map((r) => {
        const cx = (r.x + r.width / 2) / rec.naturalWidth;
        const cy = (r.y + r.height / 2) / rec.naturalHeight;
        const w = r.width / rec.naturalWidth;
        const h = r.height / rec.naturalHeight;
        return `${classIdFor(r.label)} ${f(cx)} ${f(cy)} ${f(w)} ${f(h)}`;
      });
      writeFileSync(join(labelsDir, `${rec.receiptId}.txt`), lines.join("\n") + "\n", "utf8");

      // 画像コピー (storage 参照あり & 実在時のみ)
      if (this.storage && rec.imageRef) {
        const src = this.storage.resolve(rec.imageRef);
        if (existsSync(src)) {
          const ext = rec.imageRef.split(".").pop()?.toLowerCase() ?? "jpg";
          copyFileSync(src, join(imagesDir, `${rec.receiptId}.${ext}`));
        }
      }
      n++;
    }
    return n;
  }
}

function f(v: number): string {
  return Math.min(1, Math.max(0, v)).toFixed(6);
}

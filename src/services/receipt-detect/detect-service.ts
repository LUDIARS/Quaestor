/**
 * 撮影時 detect (backend)。
 *
 * 撮影のたびに GA を学習させるのはやめ (夜間バッチが担当)、**最適化済みの勝ち遺伝子を
 * 実運用で 1 回だけ走らせて採点する**。
 *
 *  1. LLM が付けたサンプルタグ (`sample_tags`) で `resolveBestGenome` (tag → global → 既定)
 *  2. その遺伝子で sidecar `/detect` を **1 回だけ** 叩く (backend → sidecar。ブラウザは叩かない)
 *  3. 認識行を LLM 真値 (+ 人が投入時に直した値、修正後が正) と突合して本物 BB にする
 *  4. `computeOcrFitness` で採点し、運用評価レコードを 1 件発行
 *     (`production-eval.jsonl` + `receipts.metadata`)
 *  5. 本物 BB を学習データセットへ流す (`training-dataset.ts`)
 *
 * 演出との分離: 1 回 40 秒かかるので呼び出し側 (web の locator) は短い timeout で諦める。
 * 諦めても **この promise は最後まで走り**、レコードと学習データは後から発行される
 * (演出は従来の fallback で進む — spec/feature/scanner-overlay.md §1 の大原則)。
 *
 * 判定は自動化しない: 直近 20 件平均が baseline を下回っても bestGenome を既定へ戻す処理は
 * 入れず、値をログに出すだけにする (閾値は仮置き、人が B-5 のカードで見る)。
 *
 * @implements SPEC-OCR-GA-EVAL-006 (spec/feature/ocr-ga-evaluation.md)
 */

import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ReceiptRow, ReceiptsRepo } from "../../db/receipts-repo.js";
import { parseTagList } from "../../shared/document-kinds.js";
import type { ReferenceFields } from "../detection-eval.js";
import { recordDetection, type DetectionRecordDeps } from "../detection-record.js";
import type { GaStore } from "../genetic.js";
import { computeOcrFitness } from "../ocr-ga-fitness.js";
import { defaultOcrGenome, resolveBestGenome, type OcrGenome } from "../ocr-ga.js";
import type { DetectResult, OcrSidecarClient } from "../ocr-sidecar-client.js";
import type { ReceiptStorage } from "../receipt-storage.js";
import type { TrainingRegion } from "../training-dataset.js";
import { buildFieldRegions } from "./field-regions.js";
import {
  parseProductionEvalRecord, ProductionEvalLog, RECENT_EVAL_WINDOW,
} from "./production-eval-log.js";
import type {
  DetectedFieldRegion, DetectLogger, ProductionEvalRecord, ReceiptDetectOutcome,
} from "./types.js";

/** 学習レコードの engine 名。検出器そのものは PaddleOCR なので夜間バッチ・旧記録と揃える */
export const DETECT_ENGINE = "paddle";
/** receipts.metadata に置くキー (運用評価レコード本体) */
export const METADATA_EVAL_KEY = "ocr_production_eval";
/** receipts.metadata に置くキー (リプレイ用の本物 BB と検出条件) */
export const METADATA_DETECT_KEY = "ocr_detect";

export interface ReceiptDetectDeps extends DetectionRecordDeps {
  receipts: ReceiptsRepo;
  storage: ReceiptStorage;
  ga: GaStore<OcrGenome>;
  sidecar: OcrSidecarClient;
  evalLog: ProductionEvalLog;
  /** fitness のコスト項係数 (1 秒あたり)。既定 0 (運用評価では速度で減点しない) */
  costPerSecond?: number;
  /** 既定遺伝子の baseline を後追いで採るか。既定 true */
  baselineBackfill?: boolean;
  logger?: DetectLogger;
  now?: () => number;
}

export interface DetectOptions {
  /** 評価済でも sidecar を叩き直す (再撮影せずに検証したいとき) */
  force?: boolean;
}

/** metadata に置く検出スナップショット (リプレイ時に本物 BB を出し直すため) */
interface DetectSnapshot {
  /** 画像・真値・タグの改訂を検知する非可逆 fingerprint (個人データ自体は metadata に複製しない) */
  inputHash: string;
  genomeSource: "tag" | "global" | "default";
  naturalWidth: number;
  naturalHeight: number;
  regions: DetectedFieldRegion[];
}

export class ReceiptDetectService {
  private readonly inflight = new Map<string, Promise<ReceiptDetectOutcome>>();
  private readonly background = new Set<Promise<void>>();
  private readonly now: () => number;
  private closing = false;

  constructor(private readonly deps: ReceiptDetectDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * 同一 receipt への detect は 1 本に畳む (二重に 40 秒を走らせない)。
   * 呼び出し側が諦めても、先に作った promise が最後まで走ってレコードを発行する。
   */
  detect(receiptId: string, opts: DetectOptions = {}): Promise<ReceiptDetectOutcome> {
    const running = this.inflight.get(receiptId);
    if (running) return running;
    if (this.closing) return Promise.resolve(skipped(receiptId, "detect_disabled"));
    const run = this.runDetect(receiptId, opts)
      .catch((error: unknown) => this.onUnexpected(receiptId, error))
      .finally(() => { this.inflight.delete(receiptId); });
    this.inflight.set(receiptId, run);
    return run;
  }

  /** テスト・shutdown 用: baseline の後追いなど背景処理が終わるまで待つ */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0 || this.inflight.size > 0) {
      await Promise.allSettled([...this.background, ...this.inflight.values()]);
    }
  }

  /** shutdown 開始後の新規受付を止め、進行中の検出と baseline 永続化を drain する。 */
  async close(): Promise<void> {
    this.closing = true;
    await this.whenIdle();
  }

  // -------------------------------------------------------------------------

  private async runDetect(
    receiptId: string,
    opts: DetectOptions,
    inputChangeRetry = 0,
  ): Promise<ReceiptDetectOutcome> {
    const row = this.deps.receipts.find(receiptId);
    if (!row) return skipped(receiptId, "image_missing");

    if (row.ocr_status !== "done" && row.ocr_status !== "manual") {
      // 真値が無いうちに 40 秒を使わない。OCR 完了後に呼び直す
      return skipped(receiptId, "ocr_not_ready");
    }
    let truth = truthOf(row);
    if (truth.date == null && truth.payee == null && truth.total == null) {
      return skipped(receiptId, "no_truth");
    }

    if (!opts.force) {
      const cached = this.cachedOutcome(row);
      if (cached) return cached;
    }

    const tags = parseTagList(row.sample_tags);
    const resolved = resolveBestGenome(this.deps.ga, tags);

    const image = row.image_path ? this.deps.storage.load(row.image_path) : null;
    if (!image) {
      this.deps.logger?.warn({ receiptRef: receiptLogRef(receiptId) }, "receipt detect skipped: image missing");
      return skipped(receiptId, "image_missing", resolved.key, resolved.source, resolved.generation, resolved.genome);
    }

    let detected: DetectResult;
    try {
      detected = await this.deps.sidecar.detect(image, resolved.genome, `${receiptId}.jpg`);
    } catch (error: unknown) {
      // sidecar 不達・タイムアウトは 200 の空結果。理由はログに残し、演出は fallback に落ちる
      this.deps.logger?.warn(
        { receiptRef: receiptLogRef(receiptId), key: resolved.key, errorType: errorType(error) },
        "receipt detect failed: sidecar unreachable",
      );
      return skipped(receiptId, "sidecar_failed", resolved.key, resolved.source, resolved.generation, resolved.genome);
    }

    // sidecar 実行中の人手修正を正として採点する。画像や採用遺伝子まで変わった場合は、
    // 古い検出を記録せず最新入力で一度だけやり直す。
    const latest = this.deps.receipts.find(receiptId);
    if (!latest) return skipped(receiptId, "input_changed");
    if (latest.ocr_status !== "done" && latest.ocr_status !== "manual") {
      return skipped(receiptId, "ocr_not_ready");
    }
    truth = truthOf(latest);
    if (truth.date == null && truth.payee == null && truth.total == null) {
      return skipped(receiptId, "no_truth");
    }
    const latestTags = parseTagList(latest.sample_tags);
    const latestResolved = resolveBestGenome(this.deps.ga, latestTags);
    const detectionInputsChanged = latest.image_path !== row.image_path
      || !sameGenome(latestResolved.genome, resolved.genome);
    if (detectionInputsChanged) {
      this.deps.logger?.warn(
        { receiptRef: receiptLogRef(receiptId) },
        "receipt detect input changed while sidecar was running",
      );
      return inputChangeRetry === 0
        ? this.runDetect(receiptId, { ...opts, force: true }, 1)
        : skipped(receiptId, "input_changed");
    }

    const regions = buildFieldRegions(detected.lines, truth);
    const scored = computeOcrFitness(detected.lines, truth, {
      elapsedMs: detected.elapsedMs,
      costPerSecond: this.deps.costPerSecond ?? 0,
    });

    const record: ProductionEvalRecord = {
      receiptId,
      label: latestResolved.key,
      tags: latestTags,
      generation: latestResolved.generation,
      genome: latestResolved.genome,
      fitness: scored.fitness,
      fieldHits: scored.fieldHits,
      // 勝ち遺伝子が既定遺伝子そのものなら baseline は同値。それ以外は後追いで埋める
      baselineFitness: sameGenome(latestResolved.genome, defaultOcrGenome()) ? scored.fitness : null,
      elapsedMs: detected.elapsedMs,
      ts: new Date(this.now()).toISOString(),
    };

    const snapshot: DetectSnapshot = {
      inputHash: inputHash(latest),
      genomeSource: latestResolved.source,
      naturalWidth: detected.width,
      naturalHeight: detected.height,
      regions,
    };
    this.deps.evalLog.append(record);
    this.deps.receipts.mergeMetadata(receiptId, {
      [METADATA_EVAL_KEY]: record,
      [METADATA_DETECT_KEY]: snapshot,
    });

    // 本物 BB を学習データセットへ (設計書 §3.2 の「実運用 (経路)」KPI の実体)
    recordDetection(this.deps, {
      receiptId,
      imageRef: latest.image_path,
      naturalWidth: detected.width,
      naturalHeight: detected.height,
      engine: DETECT_ENGINE,
      regions: regions.map(toTrainingRegion),
      truth,
    });

    this.logSummary(record, detected.lines.length, regions.length);
    if (record.baselineFitness == null && (this.deps.baselineBackfill ?? true)) {
      this.spawn(this.backfillBaseline(receiptId, record, image, truth, detected.elapsedMs));
    }

    return {
      receiptId,
      source: regions.length > 0 ? "real" : null,
      reason: regions.length > 0 ? null : "no_lines",
      cached: false,
      key: latestResolved.key,
      genomeSource: latestResolved.source,
      generation: latestResolved.generation,
      genome: latestResolved.genome,
      naturalWidth: detected.width,
      naturalHeight: detected.height,
      regions,
      elapsedMs: detected.elapsedMs,
      eval: record,
    };
  }

  /**
   * 既定遺伝子で同じ画像をもう一度採点し、baseline を後追いで埋める。
   * 演出も detect の応答も待たせない (sidecar client 側で直列化されるので順に流れる)。
   */
  private async backfillBaseline(
    receiptId: string,
    record: ProductionEvalRecord,
    image: Buffer,
    truth: ReferenceFields,
    winnerElapsedMs: number,
  ): Promise<void> {
    try {
      const baseline = await this.deps.sidecar.detect(image, defaultOcrGenome(), `${receiptId}.baseline.jpg`);
      const scored = computeOcrFitness(baseline.lines, truth, {
        elapsedMs: baseline.elapsedMs,
        costPerSecond: this.deps.costPerSecond ?? 0,
      });
      this.deps.evalLog.setBaseline(receiptId, record.ts, scored.fitness);
      const updated: ProductionEvalRecord = { ...record, baselineFitness: scored.fitness };
      const current = this.deps.receipts.find(receiptId);
      const currentRecord = current
        ? parseProductionEvalRecord(parseMetadata(current.metadata)[METADATA_EVAL_KEY])
        : null;
      if (currentRecord?.ts === record.ts) {
        this.deps.receipts.mergeMetadata(receiptId, { [METADATA_EVAL_KEY]: updated });
      }
      this.logSummary(updated, baseline.lines.length, -1, winnerElapsedMs);
    } catch (error: unknown) {
      // baseline は後追いなので、取れなくても運用評価レコード自体は残す (null のまま)
      this.deps.logger?.warn(
        { receiptRef: receiptLogRef(receiptId), errorType: errorType(error) },
        "production eval baseline backfill failed",
      );
    }
  }

  /** 評価済 receipt を sidecar 抜きで返す (リプレイで 40 秒を使い直さない) */
  private cachedOutcome(row: ReceiptRow): ReceiptDetectOutcome | null {
    const meta = parseMetadata(row.metadata);
    const record = parseProductionEvalRecord(meta[METADATA_EVAL_KEY]);
    if (!record || record.receiptId !== row.id) return null;
    const snapshot = parseDetectSnapshot(meta[METADATA_DETECT_KEY]);
    if (!snapshot || snapshot.inputHash !== inputHash(row)) return null;
    const regions = snapshot.regions;
    return {
      receiptId: row.id,
      source: regions.length > 0 ? "real" : null,
      reason: regions.length > 0 ? null : "no_lines",
      cached: true,
      key: record.label,
      genomeSource: snapshot?.genomeSource ?? "global",
      generation: record.generation,
      genome: record.genome,
      naturalWidth: snapshot?.naturalWidth ?? 0,
      naturalHeight: snapshot?.naturalHeight ?? 0,
      regions,
      elapsedMs: record.elapsedMs,
      eval: record,
    };
  }

  /** 判定はせず値を出すだけ: 今回の fitness / fieldHits と直近 20 件の平均 (baseline 込み) */
  private logSummary(record: ProductionEvalRecord, lines: number, regions: number, baselineElapsedMs?: number): void {
    const summary = this.deps.evalLog.summary(RECENT_EVAL_WINDOW);
    this.deps.logger?.info?.({
      receiptRef: receiptLogRef(record.receiptId),
      label: record.label,
      generation: record.generation,
      fitness: record.fitness,
      baselineFitness: record.baselineFitness,
      fieldHits: record.fieldHits,
      elapsedMs: record.elapsedMs,
      baselineElapsedMs,
      lines,
      regions: regions >= 0 ? regions : undefined,
      recent: summary,
    }, "ocr-ga production eval");
  }

  private spawn(task: Promise<void>): void {
    const tracked = task.finally(() => { this.background.delete(tracked); });
    this.background.add(tracked);
  }

  private onUnexpected(receiptId: string, error: unknown): ReceiptDetectOutcome {
    this.deps.logger?.warn(
      { receiptRef: receiptLogRef(receiptId), errorType: errorType(error) },
      "receipt detect failed unexpectedly",
    );
    return skipped(receiptId, "sidecar_failed");
  }
}

// ---------------------------------------------------------------------------

function toTrainingRegion(r: DetectedFieldRegion): TrainingRegion {
  return {
    label: r.field,
    x: r.x, y: r.y, width: r.width, height: r.height,
    text: r.recognizedText,
    polygon: r.polygon,
    confidence: r.confidence,
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseDetectSnapshot(value: unknown): DetectSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<DetectSnapshot>;
  if (typeof snapshot.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.inputHash)) return null;
  if (snapshot.genomeSource !== "tag" && snapshot.genomeSource !== "global"
    && snapshot.genomeSource !== "default") return null;
  if (!isNonNegativeFinite(snapshot.naturalWidth) || !isNonNegativeFinite(snapshot.naturalHeight)) return null;
  if (!Array.isArray(snapshot.regions) || !snapshot.regions.every(isDetectedFieldRegion)) return null;
  return snapshot as DetectSnapshot;
}

function isDetectedFieldRegion(value: unknown): value is DetectedFieldRegion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const region = value as Partial<DetectedFieldRegion>;
  return typeof region.field === "string" && region.field.length > 0
    && isNonNegativeFinite(region.x) && isNonNegativeFinite(region.y)
    && isNonNegativeFinite(region.width) && isNonNegativeFinite(region.height)
    && isNonNegativeFinite(region.confidence) && region.confidence <= 1
    && typeof region.recognizedText === "string"
    && Array.isArray(region.polygon) && region.polygon.length === 4
    && region.polygon.every((point) => Array.isArray(point) && point.length === 2
      && Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function truthOf(row: ReceiptRow): ReferenceFields {
  return { date: row.date, payee: row.payee, total: row.total, items: row.items };
}

/** cache key に個人データを平文で複製せず、検出に影響する入力だけを比較する。 */
function inputHash(row: ReceiptRow): string {
  return createHash("sha256").update(JSON.stringify({
    imagePath: row.image_path,
    ocrStatus: row.ocr_status,
    truth: truthOf(row),
    sampleTags: parseTagList(row.sample_tags),
  })).digest("hex");
}

function sameGenome(a: OcrGenome, b: OcrGenome): boolean {
  return a.detThresh === b.detThresh
    && a.boxThresh === b.boxThresh
    && a.unclipRatio === b.unclipRatio
    && a.limitSideLen === b.limitSideLen
    && a.useDilation === b.useDilation
    && a.dropScore === b.dropScore;
}

/** ログへ endpoint・path・入力値を含む例外 message を出さない。 */
function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function receiptLogRef(receiptId: string): string {
  return createHash("sha256").update(receiptId).digest("hex").slice(0, 12);
}

/** 本物 BB を出せなかったときの 200 応答 (演出は fallback に落ちる) */
function skipped(
  receiptId: string,
  reason: ReceiptDetectOutcome["reason"],
  key = "global",
  genomeSource: "tag" | "global" | "default" = "default",
  generation = 0,
  genome: OcrGenome = defaultOcrGenome(),
): ReceiptDetectOutcome {
  return {
    receiptId,
    source: null,
    reason,
    cached: false,
    key,
    genomeSource,
    generation,
    genome,
    naturalWidth: 0,
    naturalHeight: 0,
    regions: [],
    elapsedMs: 0,
    eval: null,
  };
}

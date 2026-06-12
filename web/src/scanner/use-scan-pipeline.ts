/**
 * スキャンパイプラインの状態管理 hook。
 *
 * フェーズ遷移:
 *   idle → detect   : imageUrl が設定されたとき
 *   detect → analyze : スキャンライン完了 (DETECT_DURATION_MS) + 実検知後
 *   analyze → result : ocrStatus が done/manual/failed に変化したとき
 *   result → locate  : fieldLocator が有効なら RESULT_TO_LOCATE_DELAY_MS 後
 *   locate → confirm : fieldLocator.locate() 完了時
 *
 * detect フェーズでの領域表示 (スキャンライン通過時に箱を出す):
 *   - imageUrl 設定時にヒューリスティック領域を即計算
 *   - 各領域の delay = (r.y / naturalHeight) × DETECT_DURATION_MS × 0.9
 *   - スキャンラインが通過するタイミングで箱が現れる
 *   - スキャン完了後に実検知を実行し analyze 領域 (標準 delay) に差し替え
 */

import { useEffect, useRef, useState } from "react";
import {
  SobelReceiptEngine,
  receiptFieldRegions,
  fillRegionValues,
  imageDataFromUrl,
} from "./receipt-engine.js";
import type { DetectedRegion, FieldLocatorEngine, OcrFields, ScanPhase } from "./types.js";

/** スキャンライン 1 回の所要時間。CSS の --sc-dur と合わせる */
export const DETECT_DURATION_MS = 2000;

// ---------------------------------------------------------------------------
// analyze 中のノイズ演出: 実際とは無関係なオブジェクト検知を偽装
// ---------------------------------------------------------------------------
const NOISE_LABELS  = ["OBJ_A3", "OBJ_B7", "OBJ_F1", "OBJ_C9"] as const;
const NOISE_COLORS  = ["#fb923c", "#f87171", "#a78bfa", "#fbbf24"] as const;
const NOISE_POS = [
  { rx: 0.05, ry: 0.05, rw: 0.18, rh: 0.14 },
  { rx: 0.72, ry: 0.07, rw: 0.22, rh: 0.12 },
  { rx: 0.06, ry: 0.74, rw: 0.20, rh: 0.16 },
  { rx: 0.69, ry: 0.70, rw: 0.23, rh: 0.17 },
] as const;

function generateNoiseRegions(nw: number, nh: number): DetectedRegion[] {
  return NOISE_POS.map((p, i) => ({
    id:         `noise-${i}`,
    label:      NOISE_LABELS[i] ?? `OBJ_${i}`,
    x:          nw * (p.rx + (Math.random() - 0.5) * 0.04),
    y:          nh * (p.ry + (Math.random() - 0.5) * 0.04),
    width:      nw * p.rw,
    height:     nh * p.rh,
    confidence: 0.3 + Math.random() * 0.4,
    color:      NOISE_COLORS[i] ?? "#fb923c",
    kind:       "noise" as const,
    delay:      i * 380,
  }));
}
/** result スタンプ表示後 locate に移行するまでの待機時間 */
const RESULT_TO_LOCATE_DELAY_MS = 1200;

interface PipelineInput {
  imageUrl: string | null;
  naturalWidth: number;
  naturalHeight: number;
  ocrStatus: string;
  ocrFields: OcrFields | null;
  animated: boolean;
  fieldLocator?: FieldLocatorEngine;
  mode?: "receipt" | "food";
}

interface PipelineState {
  phase: ScanPhase;
  regions: DetectedRegion[];
}

export function useScanPipeline({
  imageUrl,
  naturalWidth,
  naturalHeight,
  ocrStatus,
  ocrFields,
  animated,
  fieldLocator,
  mode = "receipt",
}: PipelineInput): PipelineState {
  const [phase, setPhase]     = useState<ScanPhase>("idle");
  const [regions, setRegions] = useState<DetectedRegion[]>([]);

  const engineRef = useRef(new SobelReceiptEngine());

  // refs for async callbacks
  const fieldLocatorRef = useRef(fieldLocator);
  const imageUrlRef     = useRef(imageUrl);
  const ocrFieldsRef    = useRef(ocrFields);
  const modeRef         = useRef(mode);
  useEffect(() => { fieldLocatorRef.current = fieldLocator; }, [fieldLocator]);
  useEffect(() => { imageUrlRef.current     = imageUrl; },     [imageUrl]);
  useEffect(() => { ocrFieldsRef.current    = ocrFields; },    [ocrFields]);
  useEffect(() => { modeRef.current         = mode; },         [mode]);

  // imageUrl が届いたら detect フェーズへ
  useEffect(() => {
    if (!imageUrl || naturalWidth === 0 || naturalHeight === 0) return;
    setPhase("detect");

    // ---- スキャンライン通過タイミングで検知箱を表示するためのヒューリスティック領域 ----
    // 実検知 (非同期) を待たずに即描画。delay = y 座標がスキャンラインに追いつく時刻。
    const hMain = fallbackMainRegion(naturalWidth, naturalHeight);
    const hFields = receiptFieldRegions({
      x: hMain.x, y: hMain.y,
      width: hMain.width, height: hMain.height,
      score: 0.5, meta: emptyMeta(),
    });
    const detectRegions = hFields.map((r) => ({
      ...r,
      delay: animated
        ? Math.round((r.y / naturalHeight) * DETECT_DURATION_MS * 0.9)
        : 0,
    }));
    setRegions(detectRegions);

    // スキャンライン完了後に実検知 → analyze へ
    const timer = window.setTimeout(() => {
      void runDetection(imageUrl, naturalWidth, naturalHeight);
    }, DETECT_DURATION_MS);

    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, naturalWidth, naturalHeight]);

  async function runDetection(url: string, nw: number, nh: number) {
    try {
      const { data } = await imageDataFromUrl(url);
      const detectedMain = await engineRef.current.detect(data, nw, nh);

      const mainRegion = detectedMain[0] ?? fallbackMainRegion(nw, nh);
      const fieldRegs = receiptFieldRegions({
        x: mainRegion.x, y: mainRegion.y,
        width: mainRegion.width, height: mainRegion.height,
        score: mainRegion.confidence, meta: emptyMeta(),
      });

      setRegions([...fieldRegs, ...generateNoiseRegions(nw, nh)]);
      setPhase("analyze");
    } catch {
      setPhase("analyze");
    }
  }

  // OCR 完了を監視 → result フェーズへ
  useEffect(() => {
    if (phase !== "analyze") return;
    if (!ocrDone(ocrStatus)) return;

    const filled = ocrFields
      ? fillRegionValues(regions, ocrFields)
      : regions;

    setRegions(filled);
    setPhase("result");
  }, [phase, ocrStatus, ocrFields]); // regions は意図的に除外 (循環防止)

  // result → locate → confirm (fieldLocator が有効なときのみ)
  useEffect(() => {
    if (phase !== "result") return;
    if (!fieldLocatorRef.current) return;

    let cancelled = false;

    const t = window.setTimeout(() => {
      const fl     = fieldLocatorRef.current;
      const url    = imageUrlRef.current;
      const fields = ocrFieldsRef.current;
      const m      = modeRef.current;

      if (!fl || !url || !fields || cancelled) return;

      setPhase("locate");

      void fl.locate(url, naturalWidth, naturalHeight, fields, m).then((located) => {
        if (cancelled) return;
        if (located.length > 0) {
          setRegions(located);
          setPhase("confirm");
        }
      }).catch(() => { /* locate 失敗は静かに無視 */ });
    }, RESULT_TO_LOCATE_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, naturalWidth, naturalHeight]);

  return { phase, regions };
}

function ocrDone(status: string): boolean {
  return status === "done" || status === "manual" || status === "failed";
}

function fallbackMainRegion(nw: number, nh: number): DetectedRegion {
  const margin = 0.05;
  return {
    id: "receipt", label: "RECEIPT",
    x: nw * margin, y: nh * margin,
    width:  nw * (1 - margin * 2),
    height: nh * (1 - margin * 2),
    confidence: 0.5, color: "#00ffc8", delay: 0,
  };
}

function emptyMeta() {
  return {
    downscaleW: 0, downscaleH: 0, threshold: 24,
    fillRatio: 0, aspectRatio: 0, areaRatio: 0,
    parallelismScore: 0, textRowRatio: 0, ledgerRowRatio: 0,
    textRunDensity: 0, containsTotal: false, otherKeywordHits: 0,
  };
}

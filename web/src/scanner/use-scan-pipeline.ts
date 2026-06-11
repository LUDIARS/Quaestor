/**
 * スキャンパイプラインの状態管理 hook。
 *
 * フェーズ遷移:
 *   idle → detect   : imageUrl が設定されたとき
 *   detect → analyze : スキャンライン完了 + 矩形検知後 (~1.3s)
 *   analyze → result : ocrStatus が done/manual/failed に変化したとき
 *   result → locate  : fieldLocator が有効なら 1.2s 後に自動遷移
 *   locate → confirm : fieldLocator.locate() 完了時
 *
 * regions は各フェーズで変わる:
 *   detect  : 空
 *   analyze : field bbox 4 件 (STORE NAME / DATE / ITEMS / TOTAL)
 *   result  : 同上に OCR 値を充填したもの
 *   locate  : 同上のまま (rescan アニメーション中)
 *   confirm : FieldLocatorEngine が返した実座標 (近似または実 pixel)
 */

import { useEffect, useRef, useState } from "react";
import {
  SobelReceiptEngine,
  receiptFieldRegions,
  fillRegionValues,
  imageDataFromUrl,
} from "./receipt-engine.js";
import type { DetectedRegion, FieldLocatorEngine, OcrFields, ScanPhase } from "./types.js";

interface PipelineInput {
  imageUrl: string | null;
  naturalWidth: number;
  naturalHeight: number;
  ocrStatus: string;
  ocrFields: OcrFields | null;
  animated: boolean;
  /** 省略時は locate/confirm フェーズをスキップ */
  fieldLocator?: FieldLocatorEngine;
  mode?: "receipt" | "food";
}

interface PipelineState {
  phase: ScanPhase;
  regions: DetectedRegion[];
}

const DETECT_TO_ANALYZE_DELAY_MS = 1400;
/** result スタンプ表示後 locate に移行するまでの待機時間 */
const RESULT_TO_LOCATE_DELAY_MS  = 1200;

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
  const analyzeTimerRef = useRef<number | undefined>(undefined);

  // refs for values used in async callbacks (avoid stale closures)
  const fieldLocatorRef  = useRef(fieldLocator);
  const imageUrlRef      = useRef(imageUrl);
  const ocrFieldsRef     = useRef(ocrFields);
  const modeRef          = useRef(mode);
  useEffect(() => { fieldLocatorRef.current = fieldLocator; },  [fieldLocator]);
  useEffect(() => { imageUrlRef.current     = imageUrl; },      [imageUrl]);
  useEffect(() => { ocrFieldsRef.current    = ocrFields; },     [ocrFields]);
  useEffect(() => { modeRef.current         = mode; },          [mode]);

  // imageUrl が届いたら detect フェーズへ
  useEffect(() => {
    if (!imageUrl || naturalWidth === 0 || naturalHeight === 0) return;
    setPhase("detect");
    setRegions([]);

    const delay = animated ? DETECT_TO_ANALYZE_DELAY_MS : 0;
    analyzeTimerRef.current = window.setTimeout(() => {
      void runDetection(imageUrl, naturalWidth, naturalHeight);
    }, delay);

    return () => window.clearTimeout(analyzeTimerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, naturalWidth, naturalHeight]);

  async function runDetection(url: string, nw: number, nh: number) {
    try {
      const { data } = await imageDataFromUrl(url);
      const detectedMain = await engineRef.current.detect(data, nw, nh);

      const mainRegion = detectedMain[0] ?? fallbackMainRegion(nw, nh);
      const fieldRegs = receiptFieldRegions({
        x: mainRegion.x,
        y: mainRegion.y,
        width:  mainRegion.width,
        height: mainRegion.height,
        score:  mainRegion.confidence,
        meta:   emptyMeta(),
      });

      setRegions(fieldRegs);
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
        // locate が空を返した場合は locate フェーズのまま (onDismiss で片付ける)
      }).catch(() => {
        // locate 失敗は静かに無視 (result 表示のまま dismiss 待ち)
      });
    }, RESULT_TO_LOCATE_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, naturalWidth, naturalHeight]); // phase 変化が主トリガー

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
    confidence: 0.5,
    color: "#00ffc8",
    delay: 0,
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

/**
 * スキャンパイプラインの状態管理 hook。
 *
 * フェーズ遷移:
 *   idle → detect  : imageUrl が設定されたとき
 *   detect → analyze: スキャンライン完了 + 矩形検知後 (~1.3s)
 *   analyze → result: ocrStatus が done/manual/failed に変化したとき
 *
 * regions は各フェーズで変わる:
 *   detect  : main bbox (レシート全体)
 *   analyze : field bbox 4 件 (STORE NAME / DATE / ITEMS / TOTAL)
 *   result  : 同上に OCR 値を充填したもの
 */

import { useEffect, useRef, useState } from "react";
import {
  SobelReceiptEngine,
  receiptFieldRegions,
  fillRegionValues,
  imageDataFromUrl,
} from "./receipt-engine.js";
import type { DetectedRegion, OcrFields, ScanPhase } from "./types.js";

/** パイプラインに渡す入力 */
interface PipelineInput {
  imageUrl: string | null;
  naturalWidth: number;
  naturalHeight: number;
  ocrStatus: string;
  ocrFields: OcrFields | null;
  animated: boolean;
}

interface PipelineState {
  phase: ScanPhase;
  regions: DetectedRegion[];
}

const DETECT_TO_ANALYZE_DELAY_MS = 1400;

export function useScanPipeline({
  imageUrl,
  naturalWidth,
  naturalHeight,
  ocrStatus,
  ocrFields,
  animated,
}: PipelineInput): PipelineState {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [regions, setRegions] = useState<DetectedRegion[]>([]);

  const engineRef = useRef(new SobelReceiptEngine());
  // detect → analyze タイマー
  const analyzeTimerRef = useRef<number | undefined>(undefined);

  // imageUrl が届いたら detect フェーズへ
  useEffect(() => {
    if (!imageUrl || naturalWidth === 0 || naturalHeight === 0) return;
    setPhase("detect");
    setRegions([]);

    // スキャンライン完了後に receipt detection + analyze 遷移
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

      // メイン bbox を元に field 領域を生成
      // 検知失敗時はフルフレームをレシートと見なした fallback 領域を使う
      const mainRegion = detectedMain[0] ?? fallbackMainRegion(nw, nh);
      const fieldRegs = receiptFieldRegions({
        x: mainRegion.x,
        y: mainRegion.y,
        width: mainRegion.width,
        height: mainRegion.height,
        score: mainRegion.confidence,
        meta: emptyMeta(),
      });

      setRegions(fieldRegs);
      setPhase("analyze");
    } catch {
      // 検知エラーは analyze に fallback
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

  return { phase, regions };
}

function ocrDone(status: string): boolean {
  return status === "done" || status === "manual" || status === "failed";
}

function fallbackMainRegion(nw: number, nh: number): DetectedRegion {
  const margin = 0.05;
  return {
    id: "receipt",
    label: "RECEIPT",
    x: nw * margin, y: nh * margin,
    width: nw * (1 - margin * 2), height: nh * (1 - margin * 2),
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

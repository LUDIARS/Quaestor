/**
 * scanner/ ライブラリの共有型定義。
 * Quaestor (receipt) / Memoria (food) 両方で使う。
 */

export type ScanPhase = "idle" | "detect" | "analyze" | "result";

/** 検知エンジンが返す bounding box + メタ */
export interface DetectedRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  color?: string;
  /** Phase 3 で値が埋まる */
  value?: string;
  /** Phase 2 でのアニメーション開始遅延 (ms) */
  delay?: number;
}

/** 検知エンジン抽象インターフェース。実装を差し替えるための境界。 */
export interface DetectionEngine {
  /** imageData から検知領域を返す。結果はすでに naturalWidth/Height 座標系。 */
  detect(
    data: Uint8ClampedArray,
    naturalWidth: number,
    naturalHeight: number,
  ): Promise<DetectedRegion[]>;
}

/** アニメーション有無とモードを外部から制御する設定 */
export interface ScannerConfig {
  animated: boolean;
  mode: "receipt" | "food";
}

/** OCR 結果 (Quaestor receipt 用) */
export interface OcrFields {
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
}

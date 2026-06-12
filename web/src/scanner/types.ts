/**
 * scanner/ ライブラリの共有型定義。
 * Quaestor (receipt) / Memoria (food) 両方で使う。
 */

export type ScanPhase = "idle" | "detect" | "analyze" | "result" | "locate" | "confirm";

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
  /** ボックス種別: noise=analyze中ノイズ演出 / item=レシート個別品目 / probe=精度替え再スキャンの中間マーカー */
  kind?: "noise" | "item" | "probe";
  /**
   * BB の出所。
   *  - "real":      検出器 (PaddleOCR/Tesseract) が当てた実ピクセル座標。学習に使う本物 BB。
   *  - "heuristic": レシート比率からの推定 (演出用)。学習に使わない。
   * 未指定は "heuristic" 相当 (後方互換)。
   */
  source?: "real" | "heuristic";
  /**
   * 認識した生テキスト (学習ラベル)。
   * value は表示用に整形済 (¥付き等)、recognizedText は OCR が読んだそのまま。
   */
  recognizedText?: string;
  /** 回転レシート用の 4 点ポリゴン (PaddleOCR が返す)。naturalWidth/Height 座標系。任意。 */
  polygon?: Array<[number, number]>;
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

/**
 * フィールド座標特定エンジン — 実装差し替え境界。
 * locate フェーズで実際のピクセル座標を返す。
 * 実装例: TesseractFieldLocator / ClaudeVisionLocator / YoloFieldLocator
 */
export interface FieldLocatorEngine {
  locate(
    imageUrl: string,
    naturalWidth: number,
    naturalHeight: number,
    fields: OcrFields,
    mode: "receipt" | "food",
  ): Promise<DetectedRegion[]>;
}

/** 食事解析フィールド (Memoria food モード用) */
export interface FoodItem {
  name: string;
  kind: string;
  calories: number;
}
export interface FoodFields {
  items: FoodItem[];
}

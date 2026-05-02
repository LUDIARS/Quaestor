/**
 * Quaestor 共通型定義。
 *
 * 金額は整数 (最小通貨単位 = 円なら円、 USD なら cents) で扱う。
 * float の丸め誤差を会計で出すと致命的なため。
 */

export type SourceKind = "credit-card" | "bank" | "amazon" | "receipt" | "manual";

export interface ImportRow {
  id: number;
  source: SourceKind;
  brand: string | null;       // "ufj" | "smbc-1" | "smbc-3" | "rakuten" | "amazon-order-history" など
  account: string | null;     // 表示用ラベル: "UFJ クレカ" 等
  filename: string | null;
  imported_at: number;        // unix sec
  metadata: string | null;    // JSON
}

export interface TransactionRow {
  id: string;                 // crypto.randomUUID()
  date: string;               // ISO yyyy-mm-dd
  amount_in: number | null;   // 入金 (整数、 円)
  amount_out: number | null;  // 出金
  currency: string;           // ISO 4217、 既定 "JPY"
  fx_amount: number | null;   // 外貨決済の元金額 (実数許容、 source による)
  fx_currency: string | null;
  description: string;        // 摘要 (生)
  payee: string | null;       // 支払先 (店名 / 振込先)
  source: SourceKind;
  source_id: string | null;   // importer 由来の dedupe 鍵
  account: string | null;     // 表示用 account ラベル (UFJクレカ, SMBC-3, UFJ普通預金 等)
  import_id: number | null;
  metadata: string | null;    // JSON, source-specific
  /** 自分の口座間振り替え (カード支払引落 / ことら送金 等)。 集計から除外される */
  is_transfer: number;        // 0 / 1
  created_at: number;         // unix sec
  updated_at: number;
}

/** importer が返す中間表現。 source_id は dedupe のために必須にしたい */
export interface ImportedTransaction {
  date: string;
  amount_in: number | null;
  amount_out: number | null;
  currency: string;
  fx_amount: number | null;
  fx_currency: string | null;
  description: string;
  payee: string | null;
  source_id: string;
  account: string;
  metadata: Record<string, unknown>;
  /** 既知の振替 (口座間移動) として import 時にフラグ。 dashboard 集計から除外される */
  is_transfer?: boolean;
}

export interface ImporterResult {
  brand: string;
  account: string;
  rows: ImportedTransaction[];
  warnings: string[];
}

export interface Importer {
  /** ファイル先頭をのぞいて自分が処理できそうか判定 */
  detect(buf: Buffer): boolean;
  /** 解析。 source_id は importer 内で安定的に決める (再 import で重複しないように) */
  parse(buf: Buffer, opts?: { account?: string }): ImporterResult;
}

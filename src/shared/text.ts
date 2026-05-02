/**
 * 日付・金額・テキスト正規化ユーティリティ。
 *
 * 日本のクレカ / 銀行 CSV は SJIS 由来で表記揺れが多いので集約する。
 * calc/parse-bank-pdf.js / convert-all-with-rate.js から学んだ罠を 1 箇所に。
 */

/**
 * 多形式の日付文字列を ISO yyyy-mm-dd に正規化。
 * 失敗したら null。
 *
 * 対応形式:
 *  - 2025年1月10日 / 2025年01月10日
 *  - 2025/1/10 / 2025/01/10
 *  - 2025-01-10
 *  - 1/10 (defaultYear が必要)
 *  - 1月10日 (defaultYear が必要)
 */
export function normalizeDate(s: string, defaultYear?: number): string | null {
  if (!s) return null;
  const trimmed = s.trim();

  // YYYY年M月D日
  let m = trimmed.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);

  // YYYY/M/D or YYYY-M-D
  m = trimmed.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);

  // M/D (no year)
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m && defaultYear) return iso(defaultYear, +m[1]!, +m[2]!);

  // M月D日 (no year)
  m = trimmed.match(/^(\d{1,2})月\s*(\d{1,2})日$/);
  if (m && defaultYear) return iso(defaultYear, +m[1]!, +m[2]!);

  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/**
 * 金額文字列を整数 (最小通貨単位) に。 失敗時は null。
 * 全角数字 / カンマ / 全角空白 / アポストロフィ / マイナス記号 (− 含む) を許容。
 */
export function parseAmount(s: string | null | undefined): number | null {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t) return null;
  // 全角数字 → 半角
  t = t.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // 全角マイナス & 各種マイナス記号を ASCII -
  t = t.replace(/[−ー－]/g, "-");
  // 区切り類除去
  t = t.replace(/[,，\s　'’]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** 全角英数字 → 半角、 ノーマライズして店名比較しやすく */
export function normalizePayee(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[　\s]+/g, " ")
    .trim()
    .toUpperCase();
}

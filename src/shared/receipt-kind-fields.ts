/**
 * 書類種別ごとの固有フィールド (receipts.kind_fields、 JSON)。
 *
 *   invoice   : issuer / due_date / invoice_no
 *   utility   : supplier / period_from / period_to / usage
 *   statement : rows[] (date / description / amount)
 *   receipt / handwritten / other : 持たない (null)
 *
 * LLM 出力は形が揺れるので、 ここで種別に合わせて正規化する。 抽出できなかった項目は null。
 * 投入先の配線は `receipt-kind-destinations.ts` に置き、 ここは形の正本だけを持つ。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 */

import type { DocKind } from "./document-kinds.js";

export interface InvoiceKindFields {
  issuer: string | null;
  /** ISO yyyy-mm-dd */
  due_date: string | null;
  invoice_no: string | null;
}

export interface UtilityKindFields {
  supplier: string | null;
  /** ISO yyyy-mm-dd */
  period_from: string | null;
  period_to: string | null;
  /** 単位付きの文字列 (例 "123 kWh", "12 m3") */
  usage: string | null;
}

export interface StatementRow {
  date: string | null;
  description: string;
  /** 円 (整数)。 出金は正、 入金は負 (符号は下流で解釈) */
  amount: number | null;
}

export interface StatementKindFields {
  rows: StatementRow[];
}

export type KindFields = InvoiceKindFields | UtilityKindFields | StatementKindFields;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 200;
const MAX_STATEMENT_ROWS = 200;

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

function isoDate(v: unknown): string | null {
  return typeof v === "string" && ISO_DATE.test(v) ? v : null;
}

function integer(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const normalized = v.replace(/[,¥￥円\s]/g, "");
    if (!normalized) return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 種別に応じて kind_fields を正規化する。 その種別が固有フィールドを持たない、 または
 * 入力が object でない場合は null。
 */
export function normalizeKindFields(kind: DocKind, value: unknown): KindFields | null {
  const obj = record(value);
  switch (kind) {
    case "invoice":
      return {
        issuer: text(obj?.issuer),
        due_date: isoDate(obj?.due_date),
        invoice_no: text(obj?.invoice_no),
      };
    case "utility":
      return {
        supplier: text(obj?.supplier),
        period_from: isoDate(obj?.period_from),
        period_to: isoDate(obj?.period_to),
        usage: text(obj?.usage),
      };
    case "statement": {
      const rowsIn = Array.isArray(obj?.rows) ? obj.rows : [];
      const rows: StatementRow[] = [];
      for (const r of rowsIn) {
        const row = record(r);
        if (!row) continue;
        const description = text(row.description) ?? "";
        rows.push({ date: isoDate(row.date), description, amount: integer(row.amount) });
        if (rows.length >= MAX_STATEMENT_ROWS) break;
      }
      return { rows };
    }
    default:
      return null;
  }
}

/** DB 列 (JSON 文字列) → 正規化済み kind_fields。 壊れていれば null。 */
export function parseKindFields(kind: DocKind, json: string | null | undefined): KindFields | null {
  if (!json) return null;
  try {
    return normalizeKindFields(kind, JSON.parse(json));
  } catch {
    return null;
  }
}

export function invoiceFields(kind: DocKind, json: string | null | undefined): InvoiceKindFields | null {
  return kind === "invoice" ? (parseKindFields(kind, json) as InvoiceKindFields | null) : null;
}

export function utilityFields(kind: DocKind, json: string | null | undefined): UtilityKindFields | null {
  return kind === "utility" ? (parseKindFields(kind, json) as UtilityKindFields | null) : null;
}

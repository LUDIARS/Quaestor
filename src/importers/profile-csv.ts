/**
 * 列マッピング・プロファイル (statement_profiles) を使った汎用 CSV importer。
 *
 * UFJ/SMBC のような固有ロジック (カード番号→口座、 FX 列) は持たず、
 * 「日付/店名/金額の列番号 + 文字コード + ヘッダ行数 + 行フィルタ」 で
 * 任意のクレカ/明細 CSV をデータ駆動で取り込む。
 */

import { createHash } from "node:crypto";
import { decodeBuffer, parseCsv } from "./csv-utils.js";
import type { ImporterResult, ImportedTransaction } from "../shared/types.js";
import type { StatementProfileRow } from "../db/statement-profiles-repo.js";
import { normalizeDate, parseAmount } from "../shared/text.js";

function encodingHint(p: StatementProfileRow): "utf8" | "sjis" | undefined {
  if (p.encoding === "utf-8") return "utf8";
  if (p.encoding === "shift_jis") return "sjis";
  return undefined;   // auto: csv-utils が sniff する
}

/** プロファイル定義で CSV を解析する。 */
export function parseWithProfile(
  profile: StatementProfileRow,
  buf: Buffer,
  opts?: { account?: string },
): ImporterResult {
  const text = decodeBuffer(buf, encodingHint(profile));
  const rows = parseCsv(text);
  const out: ImportedTransaction[] = [];
  const warnings: string[] = [];
  const account = opts?.account ?? profile.account_default ?? profile.name;

  for (let i = profile.header_skip; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every((c) => c.trim() === "")) continue;

    // 行フィルタ (例 UFJ "確定" 列)
    if (profile.filter_col != null) {
      const cell = (row[profile.filter_col] ?? "").trim();
      if (cell !== profile.filter_value) continue;
    }

    const dateRaw = (row[profile.col_date] ?? "").trim();
    const date = normalizeDate(dateRaw, profile.date_year_hint ?? undefined);
    if (!date) {
      warnings.push(`row ${i}: 日付パース失敗 "${dateRaw}"`);
      continue;
    }
    const amount = parseAmount(row[profile.col_amount]);
    if (amount == null || amount === 0) {
      warnings.push(`row ${i}: 金額パース失敗 "${row[profile.col_amount] ?? ""}"`);
      continue;
    }
    const payee = (row[profile.col_payee] ?? "").trim();
    const memo = profile.col_memo != null ? (row[profile.col_memo] ?? "").trim() : "";

    let amountIn: number | null = null;
    let amountOut: number | null = null;
    if (profile.amount_sign === "in") {
      amountIn = Math.abs(amount);
    } else if (profile.amount_sign === "signed") {
      if (amount >= 0) amountIn = amount;
      else amountOut = Math.abs(amount);
    } else {
      amountOut = Math.abs(amount);
    }

    out.push({
      date,
      amount_in: amountIn,
      amount_out: amountOut,
      currency: "JPY",
      fx_amount: null,
      fx_currency: null,
      description: memo || payee,
      payee,
      source_id: stableId(profile.brand, { account, date, amount, payee, memo }),
      account,
      metadata: { brand: profile.brand, profile_id: profile.id, memo },
    });
  }

  return { brand: profile.brand, account, rows: out, warnings };
}

/**
 * enabled プロファイルの detect_keywords を decode 後の本文先頭に当てて auto-detect する。
 * 最初にマッチしたプロファイルを返す。 keywords が空のプロファイルは対象外。
 */
export function detectProfile(
  profiles: StatementProfileRow[],
  buf: Buffer,
): StatementProfileRow | null {
  for (const p of profiles) {
    const keywords = parseKeywords(p.detect_keywords);
    if (keywords.length === 0) continue;
    const head = decodeBuffer(buf, encodingHint(p)).slice(0, 4096);
    if (keywords.every((kw) => head.includes(kw))) return p;
  }
  return null;
}

function parseKeywords(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

function stableId(
  brand: string,
  p: { account: string; date: string; amount: number; payee: string; memo: string },
): string {
  const h = createHash("sha1");
  h.update([p.account, p.date, p.amount, p.payee, p.memo].join("\x1f"));
  return `${brand}:${h.digest("hex").slice(0, 16)}`;
}

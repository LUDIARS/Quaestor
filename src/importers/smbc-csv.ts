/**
 * SMBC 三井住友カード明細 CSV 取込。
 *
 * 元 CSV (Shift_JIS) のレイアウト (calc/convert-all-with-rate.js convertSMBC 参照):
 *   row[0]  ご利用日 (or カード番号関連 — 1 行目)
 *   row[1]  店名 (or カード番号 — 1 行目)
 *   row[2]  ご利用金額
 *   row[3]  支払回数
 *   row[4]  分割支払
 *   row[5]  支払総額
 *   row[6]  メモ
 *
 * 1 行目の row[1] にカード番号 (例 "4980-09-XXXX-XXXX") が入っているケースが多く、
 * これで card brand を識別できる。 ただし常にあるとは限らないので、 caller から
 * account を明示渡しも受ける。
 */

import { createHash } from "node:crypto";
import { decodeBuffer, parseCsv } from "./csv-utils.js";
import type { Importer, ImporterResult, ImportedTransaction } from "../shared/types.js";
import { normalizeDate, parseAmount } from "../shared/text.js";

const ACCOUNT_DEFAULT = "SMBCクレカ";

/** カード番号プレフィクス → デフォルト account label の対応 (calc 由来の慣習) */
const CARD_PREFIX_TO_ACCOUNT: Record<string, string> = {
  "4980-09": "SMBCカード-3",
  "5358-18": "SMBCカード-4",
  "4980-05": "SMBCカード-1",
};

export const smbcCsvImporter: Importer = {
  detect(buf: Buffer): boolean {
    const text = decodeBuffer(buf).slice(0, 4096);
    // SMBC は確定/未確定の概念ではなく、 行 1 にカード番号が入る + 「ご利用日」「ご利用店名」見出し
    // ただし新フォーマットは header 無しで日付始まりの場合もある。 緩めに判定:
    const hasSmbcMarker =
      /三井住友(?:カード|VISA)/i.test(text) ||
      /\d{4}-\d{2}-\d{4}-\d{4}/.test(text) ||
      /ご利用店名|ご利用日.*ご利用店名/i.test(text);
    return hasSmbcMarker;
  },

  parse(buf: Buffer, opts?: { account?: string }): ImporterResult {
    const text = decodeBuffer(buf);
    const rows = parseCsv(text);
    const out: ImportedTransaction[] = [];
    const warnings: string[] = [];

    if (rows.length === 0) {
      return { brand: "smbc", account: opts?.account ?? ACCOUNT_DEFAULT, rows: out, warnings: ["empty csv"] };
    }

    // account 自動決定: opts > カード番号 prefix > default
    const firstRow = rows[0]!;
    let account = opts?.account ?? ACCOUNT_DEFAULT;
    if (!opts?.account) {
      for (const cell of firstRow) {
        const m = /(\d{4}-\d{2})-\d{4}-\d{4}/.exec(cell);
        if (m && CARD_PREFIX_TO_ACCOUNT[m[1]!]) {
          account = CARD_PREFIX_TO_ACCOUNT[m[1]!]!;
          break;
        }
      }
    }

    // データ行は 1 行目以降。 ヘッダ風の行 (ご利用日 etc) を判別して skip
    let startIdx = 0;
    // 1 行目が日付パース可能なら header なし、 そうでなければ header 行と見なし skip
    const firstDateGuess = normalizeDate((firstRow[0] ?? "").trim());
    if (!firstDateGuess) startIdx = 1;
    // 念のため次の行も「ご利用日」を含むなら header 続きとして skip
    while (startIdx < rows.length && /ご利用日|利用日|お支払日|お支払金額/.test(rows[startIdx]!.join(""))) {
      startIdx++;
    }

    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i]!;
      const dateRaw = (row[0] ?? "").trim();
      if (!dateRaw) continue;
      const date = normalizeDate(dateRaw);
      if (!date) {
        warnings.push(`row ${i}: 日付パース失敗 "${dateRaw}"`);
        continue;
      }
      const payee = (row[1] ?? "").trim();
      const amount = parseAmount(row[2]);
      if (amount == null || amount === 0) {
        warnings.push(`row ${i}: 金額パース失敗 "${row[2]}"`);
        continue;
      }
      const memo = (row[6] ?? "").trim();

      out.push({
        date,
        amount_in: null,
        amount_out: amount,
        currency: "JPY",
        fx_amount: null,
        fx_currency: null,
        description: memo || payee,
        payee,
        source_id: stableId({ account, date, amount, payee, memo }),
        account,
        metadata: {
          brand: "smbc",
          card_account: account,
          payment_kind: row[3] ?? "",
          memo,
        },
      });
    }

    return { brand: "smbc", account, rows: out, warnings };
  },
};

function stableId(p: { account: string; date: string; amount: number; payee: string; memo: string }): string {
  const h = createHash("sha1");
  h.update([p.account, p.date, p.amount, p.payee, p.memo].join("\x1f"));
  return `smbc:${h.digest("hex").slice(0, 16)}`;
}

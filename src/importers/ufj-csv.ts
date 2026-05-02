/**
 * 三菱 UFJ ニコス クレジットカード明細 CSV 取込。
 *
 * 元 CSV (Shift_JIS) のレイアウト:
 *   col[0]  確定情報 / 確定 / (空)        ← '確定' のみ取込対象
 *   col[1]  カード会員番号など
 *   col[2]  店名
 *   col[3]  ご利用日 (YYYY/M/D 等)
 *   col[4]  ご利用区分 (1回払い 等)
 *   col[5]  入会後支払回数
 *   col[6]  ご利用金額 (円)
 *   col[7]  支払総額
 *   ...
 *
 * calc/convert-all-with-rate.js convertUFJ() を参考に、 dedupe 用 source_id を付与した形に整える。
 */

import { createHash } from "node:crypto";
import { decodeBuffer, parseCsv } from "./csv-utils.js";
import type { Importer, ImporterResult, ImportedTransaction } from "../shared/types.js";
import { normalizeDate, parseAmount } from "../shared/text.js";

const ACCOUNT_DEFAULT = "UFJクレカ";

export const ufjCsvImporter: Importer = {
  detect(buf: Buffer): boolean {
    const text = decodeBuffer(buf);
    const head = text.split(/\r?\n/, 8).join("\n");
    // 「確定情報」または「確定」 + ご利用日らしき列がいる
    return /確定情報|確定/.test(head) && /ご利用日|利用日|2\d{3}\/\d/.test(head);
  },

  parse(buf: Buffer, opts?: { account?: string }): ImporterResult {
    const text = decodeBuffer(buf);
    const rows = parseCsv(text);
    const out: ImportedTransaction[] = [];
    const warnings: string[] = [];
    const account = opts?.account ?? ACCOUNT_DEFAULT;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const status = (row[0] ?? "").trim();
      if (status !== "確定") continue;
      const dateRaw = (row[3] ?? "").trim();
      const date = normalizeDate(dateRaw);
      if (!date) {
        warnings.push(`row ${i}: 日付パース失敗 "${dateRaw}"`);
        continue;
      }
      const payee = (row[2] ?? "").trim();
      const amountRaw = row[6] ?? "";
      const amount = parseAmount(amountRaw);
      if (amount == null || amount === 0) {
        warnings.push(`row ${i}: 金額パース失敗 "${amountRaw}"`);
        continue;
      }
      const memo = (row[4] ?? "").trim();
      const fxRaw = row[10];
      const fxAmount = fxRaw ? parseAmount(fxRaw) : null;
      const fxCurrency = (row[11] ?? "").trim() || null;

      const sourceId = stableId({
        date,
        amount,
        payee,
        memo,
        account,
        idx: i,
      });

      out.push({
        date,
        amount_in: null,
        amount_out: amount,                 // クレカ利用は出金扱い
        currency: "JPY",
        fx_amount: fxAmount,
        fx_currency: fxCurrency && fxCurrency !== "JPY" ? fxCurrency : null,
        description: memo || payee,
        payee,
        source_id: sourceId,
        account,
        metadata: {
          raw_row: row,
          brand: "ufj",
          payment_kind: memo,
        },
      });
    }
    return { brand: "ufj", account, rows: out, warnings };
  },
};

/**
 * dedupe 鍵。 同 CSV を再 import しても同じ id が出るよう、 行 idx は使わない。
 * 同日同店同額が複数件発生したら衝突するが、 現実の利用では稀。 衝突時は後勝ちで上書きされず insertOne が duplicate として返す。
 */
function stableId(p: { date: string; amount: number; payee: string; memo: string; account: string; idx: number }): string {
  const h = createHash("sha1");
  h.update([p.account, p.date, p.amount, p.payee, p.memo].join("\x1f"));
  return `ufj:${h.digest("hex").slice(0, 16)}`;
}

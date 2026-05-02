/**
 * 三井住友銀行の入出金明細 PDF を取込。
 *
 * 設計:
 *   pure な行解析関数 parseSmbcBankText(text: string) と、 pdf-parse でラップする
 *   smbcBankPdfImporter に分離。 PDF の text 化は third-party、 行解析は単体テスト可能。
 *
 * 元 PDF (calc/parse-bank-pdf.js から学んだ慣習):
 *   - 「お取引日 / お引出し / お預入れ / お取り扱い内容 / 残高」の表
 *   - 行頭は日付 (YYYY/M/D, M/D, M月D日 等)
 *   - 引出/預入/残高は数値 + カンマ
 */

import { createHash } from "node:crypto";
import type { Importer, ImporterResult, ImportedTransaction } from "../shared/types.js";
import { normalizeDate, parseAmount } from "../shared/text.js";

const ACCOUNT_DEFAULT = "SMBC普通預金";

export interface SmbcParseOptions {
  account?: string;
  /** 年なし日付 (M/D 形式) のとき補完する年。 PDF メタや明細書見出しから取れる想定 */
  defaultYear?: number;
}

export interface ParsedSmbcLine {
  date: string;          // ISO yyyy-mm-dd
  payout: number | null;
  deposit: number | null;
  balance: number | null;
  memo: string;
}

/**
 * SMBC 明細 PDF を pdf-parse でテキスト化したものを行解析する純関数。
 * PDF の表は罫線ベースのレイアウト復元を諦め、 「日付プレフィクス + その後の数値群 + 残り」で割る。
 */
export function parseSmbcBankText(text: string, opts: SmbcParseOptions = {}): {
  rows: ParsedSmbcLine[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const out: ParsedSmbcLine[] = [];
  const defaultYear = opts.defaultYear ?? guessYear(text);

  const lines = text.split(/\r?\n/);
  let prevBalance: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/お取引日|お引出し|お預入れ|残高|お取り扱い内容|ページ|合計/.test(line) && !/^\d/.test(line)) {
      // header / footer 行
      continue;
    }
    const m = parseLine(line, defaultYear, prevBalance);
    if (!m) continue;
    out.push(m);
    if (m.balance != null) prevBalance = m.balance;
  }
  if (out.length === 0) warnings.push("no lines matched SMBC bank pattern");
  return { rows: out, warnings };
}

const DEPOSIT_KEYWORDS = /給与|入金|振込.*[入受]|預入|還付|還元|受取|配当|入(?!力)|預金/;
const PAYOUT_KEYWORDS = /引出|出金|ATM|振込|送金|支払|引落|料金|決済|振替|手数料/;

function parseLine(line: string, defaultYear: number | undefined, prevBalance: number | null): ParsedSmbcLine | null {
  // 行頭の日付を捕捉
  const dateMatch = line.match(/^(\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)\s+/);
  if (!dateMatch) return null;
  const date = normalizeDate(dateMatch[1]!, defaultYear);
  if (!date) return null;

  const rest = line.slice(dateMatch[0].length);
  // 数字 + カンマ列を全部抽出 (空白で割られた 3 列構造の代替)
  const nums = [...rest.matchAll(/[\d,]+/g)].map((m) => ({ idx: m.index ?? 0, raw: m[0] }));
  if (nums.length === 0) return null;

  const trailing = nums.slice(-3).map((n) => parseAmount(n.raw)).filter((x): x is number => x != null);
  let payout: number | null = null;
  let deposit: number | null = null;
  let balance: number | null = null;

  // memo は日付直後 〜 最初の数値の手前
  const firstNumIdx = nums[0]!.idx;
  const memo = rest.slice(0, firstNumIdx).trim();

  if (trailing.length === 3) {
    // [payout, deposit, balance] の慣習。 0 は null に正規化
    [payout, deposit, balance] = [trailing[0]!, trailing[1]!, trailing[2]!];
    if (payout === 0) payout = null;
    if (deposit === 0) deposit = null;
  } else if (trailing.length === 2) {
    // 1 つは出 or 入、 もう 1 つは残高 (末尾)
    const [first, last] = [trailing[0]!, trailing[1]!];
    balance = last;
    // 判別 1: prev balance との差分
    if (prevBalance != null) {
      const diff = balance - prevBalance;
      if (diff > 0 && Math.abs(diff - first) < 2) deposit = first;
      else if (diff < 0 && Math.abs(-diff - first) < 2) payout = first;
    }
    // 判別 2: 差分で決まらなければ memo キーワード
    if (deposit == null && payout == null) {
      if (DEPOSIT_KEYWORDS.test(memo)) deposit = first;
      else if (PAYOUT_KEYWORDS.test(memo)) payout = first;
      else payout = first;  // 不明は出金扱い (家計の保守側)
    }
    if (deposit === 0) deposit = null;
    if (payout === 0) payout = null;
  } else if (trailing.length === 1) {
    balance = trailing[0]!;
  }

  return { date, payout, deposit, balance, memo };
}

function guessYear(text: string): number | undefined {
  const m = text.match(/(\d{4})年/);
  if (m) return +m[1]!;
  // PDF に年が無い場合は今年
  return new Date().getUTCFullYear();
}

/**
 * pdf-parse 経由の Importer。 buf が PDF (先頭 4 byte が "%PDF") なら処理。
 * pdf-parse は dynamic import で起動 — テスト不要環境への重い依存を避ける。
 */
export const smbcBankPdfImporter: Importer = {
  detect(buf: Buffer): boolean {
    return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  },

  parse(_buf: Buffer, _opts?: { account?: string }): ImporterResult {
    // detect は同期だが parse は async が要るのに interface が同期。
    // 一旦 throw して、 caller (api/imports.ts) 側で PDF 用の async path を別建てにすることを提案。
    // ただし API 互換のため、 ここではエラー文字列を warnings に載せて空 result を返す。
    return {
      brand: "smbc-bank",
      account: ACCOUNT_DEFAULT,
      rows: [],
      warnings: [
        "smbcBankPdfImporter.parse は同期 interface に乗らないため、 専用 async API が必要。",
        "現状 v0.7 では parseSmbcBankPdf() 関数 (async) を直接呼ぶ運用とする。",
      ],
    };
  },
};

/**
 * 真の PDF→明細抽出関数。 同期 Importer interface に乗らない (pdf-parse が async) ため、
 * api/imports.ts 側で呼び出す。 source_id は (account, date, payout, deposit, balance, memo) hash。
 */
export async function parseSmbcBankPdf(
  buf: Buffer,
  opts: SmbcParseOptions = {},
): Promise<ImporterResult> {
  // dynamic import — pdf-parse は heavy なので必要時のみ
  const mod = await import("pdf-parse");
  const pdfParse = (mod as { default?: typeof mod } & typeof mod).default ?? mod;
  // @ts-expect-error pdf-parse の型が default export を完全には記述していないため
  const result = await pdfParse(buf);
  const text: string = result.text ?? "";
  const account = opts.account ?? ACCOUNT_DEFAULT;
  const parsed = parseSmbcBankText(text, opts);
  const rows: ImportedTransaction[] = parsed.rows.map((r) => ({
    date: r.date,
    amount_in: r.deposit,
    amount_out: r.payout,
    currency: "JPY",
    fx_amount: null,
    fx_currency: null,
    description: r.memo || "(no memo)",
    payee: r.memo || null,
    source_id: stableId(account, r),
    account,
    metadata: {
      brand: "smbc-bank",
      balance: r.balance,
    },
  }));
  return {
    brand: "smbc-bank",
    account,
    rows,
    warnings: parsed.warnings,
  };
}

function stableId(account: string, r: ParsedSmbcLine): string {
  const h = createHash("sha1");
  h.update([account, r.date, r.payout ?? "", r.deposit ?? "", r.balance ?? "", r.memo].join("\x1f"));
  return `smbc-bank:${h.digest("hex").slice(0, 16)}`;
}

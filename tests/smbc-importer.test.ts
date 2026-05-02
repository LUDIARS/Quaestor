import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import iconv from "iconv-lite";
import { smbcCsvImporter } from "../src/importers/smbc-csv.js";
import { parseSmbcBankText } from "../src/importers/smbc-bank-pdf.js";

function syntheticSmbcCardCsv(): Buffer {
  // 1 行目にカード番号 (4980-09-XXXX-XXXX → SMBCカード-3 自動判別)
  const text = [
    "三井住友VISAカード,4980-09-1234-5678,,,,,,",
    "ご利用日,ご利用店名,ご利用金額,支払回数,分割支払,支払総額,メモ",
    "2025/3/12,サイゼリヤ／ＮＦＣ,1820,1,,1820,",
    "2025/3/15,NETFLIX.COM,1980,1,,1980,",
    "2025/3/20,Amazon.co.jp,3500,1,,3500,通常配送",
  ].join("\r\n");
  return iconv.encode(text, "Shift_JIS");
}

describe("smbcCsvImporter", () => {
  it("detects SMBC CSV via card number", () => {
    expect(smbcCsvImporter.detect(syntheticSmbcCardCsv())).toBe(true);
  });

  it("auto-detects account label from card prefix 4980-09 → SMBCカード-3", () => {
    const r = smbcCsvImporter.parse(syntheticSmbcCardCsv());
    expect(r.account).toBe("SMBCカード-3");
    expect(r.rows).toHaveLength(3);
  });

  it("respects opts.account override", () => {
    const r = smbcCsvImporter.parse(syntheticSmbcCardCsv(), { account: "MyCard" });
    expect(r.account).toBe("MyCard");
  });

  it("parses date / payee / amount", () => {
    const r = smbcCsvImporter.parse(syntheticSmbcCardCsv());
    const netflix = r.rows.find((x) => x.payee?.includes("NETFLIX"));
    expect(netflix).toBeDefined();
    expect(netflix!.date).toBe("2025-03-15");
    expect(netflix!.amount_out).toBe(1980);
    expect(netflix!.currency).toBe("JPY");
  });

  it("source_id stable across re-parse", () => {
    const a = smbcCsvImporter.parse(syntheticSmbcCardCsv()).rows.map((x) => x.source_id);
    const b = smbcCsvImporter.parse(syntheticSmbcCardCsv()).rows.map((x) => x.source_id);
    expect(a).toEqual(b);
  });
});

describe("parseSmbcBankText", () => {
  it("parses simple withdrawal/deposit/balance triple", () => {
    const text = [
      "お取引日 お取り扱い内容 お引出し お預入れ 残高",
      "2025/4/1 給与振込 セイカイシャ 200,000 1,200,000",
      "2025/4/3 ATM 引出 5,000 1,195,000",
      "2025/4/5 振替 楽天カード 10,000 1,185,000",
    ].join("\n");
    const r = parseSmbcBankText(text, { defaultYear: 2025 });
    expect(r.rows).toHaveLength(3);

    const salary = r.rows[0]!;
    expect(salary.date).toBe("2025-04-01");
    expect(salary.deposit).toBe(200000);
    expect(salary.payout).toBeNull();
    expect(salary.balance).toBe(1200000);
    expect(salary.memo).toContain("給与");

    const atm = r.rows[1]!;
    expect(atm.payout).toBe(5000);
    expect(atm.deposit).toBeNull();
    expect(atm.balance).toBe(1195000);
  });

  it("falls back to defaultYear for M/D shorthand", () => {
    const text = "4/1 何か 1,000 99,000";
    const r = parseSmbcBankText(text, { defaultYear: 2026 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.date).toBe("2026-04-01");
  });

  it("skips header / footer lines", () => {
    const text = [
      "三井住友銀行 入出金明細",
      "口座番号: 1234567",
      "ページ 1/3",
      "お取引日  お取り扱い内容  お引出し  お預入れ  残高",
      "2025/4/1 ATM入金 50,000 50,000",
    ].join("\n");
    const r = parseSmbcBankText(text, { defaultYear: 2025 });
    expect(r.rows).toHaveLength(1);
  });

  it("emits warning when no lines match", () => {
    const r = parseSmbcBankText("foo bar baz");
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

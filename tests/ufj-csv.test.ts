import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import iconv from "iconv-lite";
import { ufjCsvImporter } from "../src/importers/ufj-csv.js";
import { normalizePayee } from "../src/shared/text.js";

/**
 * 合成 UFJ CSV (実データではなく、 列構造のみ模擬) を SJIS で生成するヘルパ。
 */
function syntheticUfjCsv(): Buffer {
  const text = [
    "確定情報,カード番号,店名,ご利用日,ご利用区分,支払回数,ご利用金額,支払総額,,,,",
    "確定,1234,NOTION LABS INC.,2025/1/15,1回払い,,14679,14679,,,,",
    "確定,1234,ＡＭＡＺＯＮ　ＷＥＢ　ＳＥＲＶ,2025/2/3,1回払い,,3210,3210,,,21,USD",
    "確定,1234,サイゼリヤ／ＮＦＣ,2025/3/12,1回払い,,1820,1820,,,,",
    "未確定,1234,SOMETHING,2025/4/1,1回払い,,500,500,,,,",   // 未確定は除外
    ",,,,,,,,,,,",                                        // 空行
  ].join("\r\n");
  return iconv.encode(text, "Shift_JIS");
}

describe("ufjCsvImporter", () => {
  it("detects UFJ CSV (SJIS)", () => {
    expect(ufjCsvImporter.detect(syntheticUfjCsv())).toBe(true);
  });

  it("does not detect random CSV", () => {
    const buf = Buffer.from("foo,bar,baz\r\n1,2,3\r\n", "utf8");
    expect(ufjCsvImporter.detect(buf)).toBe(false);
  });

  it("parses 確定 rows only and skips 未確定 / 空行", () => {
    const r = ufjCsvImporter.parse(syntheticUfjCsv());
    expect(r.brand).toBe("ufj");
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]!.payee).toBe("NOTION LABS INC.");
    expect(r.rows[0]!.amount_out).toBe(14679);
    expect(r.rows[0]!.date).toBe("2025-01-15");
    expect(r.rows[0]!.currency).toBe("JPY");
    expect(r.rows[0]!.amount_in).toBeNull();
  });

  it("captures fx fields when present", () => {
    const r = ufjCsvImporter.parse(syntheticUfjCsv());
    const aws = r.rows.find((x) => /AMAZON/.test(normalizePayee(x.payee)));
    expect(aws).toBeDefined();
    expect(aws!.fx_currency).toBe("USD");
    expect(aws!.fx_amount).toBe(21);
  });

  it("source_id is stable across re-parse of same buffer", () => {
    const r1 = ufjCsvImporter.parse(syntheticUfjCsv());
    const r2 = ufjCsvImporter.parse(syntheticUfjCsv());
    expect(r1.rows.map((x) => x.source_id)).toEqual(r2.rows.map((x) => x.source_id));
  });
});

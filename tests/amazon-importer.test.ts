import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { amazonOrderHistoryImporter } from "../src/importers/amazon-order-history.js";

/**
 * 合成 Amazon order history CSV (UTF-8、 ヘッダ + 数行)。
 * 列の組合せは実 export に近い順序を再現するが、 importer は header 名で取るので順序は重要でない。
 */
function syntheticCsv(): Buffer {
  const text = [
    "Website,Order ID,Order Date,Currency,Unit Price,Unit Price Tax,Total Owed,Quantity,Order Status,Ship Date,Product Name",
    `amazon.co.jp,250-0001,2025-01-10,JPY,1500,0,1500,1,Closed,2025-01-12,SDカード 64GB`,
    `amazon.co.jp,250-0001,2025-01-10,JPY,500,0,500,2,Closed,2025-01-12,microUSB ケーブル`,
    // 同 order の別 shipment (shipDate 違い) → 別 shipment として扱われる
    `amazon.co.jp,250-0001,2025-01-10,JPY,3000,0,3000,1,Closed,2025-01-15,本: TypeScript 入門`,
    // Cancelled は除外
    `amazon.co.jp,250-9999,2025-01-20,JPY,9999,0,9999,1,Cancelled,,キャンセル品`,
    // 別 order 単 item
    `amazon.co.jp,250-0002,2025-02-03,JPY,2000,0,2000,1,Closed,2025-02-05,USB-C ハブ`,
  ].join("\r\n");
  return Buffer.from(text, "utf8");
}

describe("amazonOrderHistoryImporter", () => {
  it("detects amazon CSV", () => {
    expect(amazonOrderHistoryImporter.detect(syntheticCsv())).toBe(true);
  });

  it("does not detect random CSV", () => {
    expect(amazonOrderHistoryImporter.detect(Buffer.from("foo,bar\r\n1,2\r\n", "utf8"))).toBe(false);
  });

  it("groups by (order_id, ship_date) into shipments", () => {
    const r = amazonOrderHistoryImporter.parse(syntheticCsv());
    // 250-0001 の 2 shipments (1/12 と 1/15) + 250-0002 の 1 shipment = 計 3
    expect(r.rows).toHaveLength(3);

    // 1/12 shipment は 2 行 (SDカード + microUSB) の Total Owed 合算
    // Amazon の Total Owed は line-level 合計 (qty 倍は既込) なので 1500 + 500 = 2000
    const sh0112 = r.rows.find((x) => x.date === "2025-01-12");
    expect(sh0112).toBeDefined();
    expect(sh0112!.amount_out).toBe(2000);
    const md = sh0112!.metadata as { items: unknown[]; order_id: string };
    expect(md.items).toHaveLength(2);
    expect(md.order_id).toBe("250-0001");

    // 1/15 shipment は単独 3000
    const sh0115 = r.rows.find((x) => x.date === "2025-01-15");
    expect(sh0115!.amount_out).toBe(3000);

    // 2/5 shipment
    const sh0205 = r.rows.find((x) => x.date === "2025-02-05");
    expect(sh0205!.amount_out).toBe(2000);
  });

  it("excludes Cancelled rows", () => {
    const r = amazonOrderHistoryImporter.parse(syntheticCsv());
    const cancelled = r.rows.find((x) => x.amount_out === 9999);
    expect(cancelled).toBeUndefined();
  });

  it("payee is Amazon, currency JPY, source_id stable", () => {
    const r = amazonOrderHistoryImporter.parse(syntheticCsv());
    for (const x of r.rows) {
      expect(x.payee).toBe("Amazon");
      expect(x.currency).toBe("JPY");
      expect(x.source_id).toMatch(/^amazon:/);
    }
    // re-parse → 同じ source_id
    const r2 = amazonOrderHistoryImporter.parse(syntheticCsv());
    expect(r.rows.map((x) => x.source_id).sort()).toEqual(r2.rows.map((x) => x.source_id).sort());
  });

  it("falls back to order_date when ship_date is empty", () => {
    const text = [
      "Order ID,Order Date,Total Owed,Order Status,Ship Date,Product Name",
      `250-9001,2025-03-10,1234,Pending,,デジタル商品`,
    ].join("\r\n");
    const r = amazonOrderHistoryImporter.parse(Buffer.from(text, "utf8"));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.date).toBe("2025-03-10");
    expect(r.rows[0]!.amount_out).toBe(1234);
  });
});

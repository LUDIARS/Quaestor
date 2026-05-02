/**
 * Amazon "Your Orders" レポートの Retail.OrderHistory.X.csv を取り込む。
 *
 * 入手元: amazon.co.jp の `Your Orders` → `Order History Reports` で zip ダウンロード
 *         展開後の `Retail.OrderHistory.<番号>.csv`
 *
 * 重要な単位: **shipment** = (Order ID, Ship Date) の組。 1 オーダーで複数発送が分かれることがあり、
 * クレカ明細に出る charge の単位はこちら (個別 item ではない)。
 *
 * calc/match_amazon3.js のロジックを移植 + header 名ベースに書き直し (列順変動への耐性向上)。
 */

import { createHash } from "node:crypto";
import { decodeBuffer, parseCsv } from "./csv-utils.js";
import type { Importer, ImporterResult, ImportedTransaction } from "../shared/types.js";
import { normalizeDate, parseAmount } from "../shared/text.js";

const ACCOUNT_DEFAULT = "Amazon";

interface ShipmentItem {
  product: string;
  total_owed: number;
  qty: number;
  unit_price: number;
  unit_tax: number;
}

interface Shipment {
  order_id: string;
  order_date: string | null;
  ship_date: string | null;
  status: string;
  total: number;
  items: ShipmentItem[];
  card_hint: string;
}

export const amazonOrderHistoryImporter: Importer = {
  detect(buf: Buffer): boolean {
    const text = decodeBuffer(buf).slice(0, 8192);
    // Amazon の CSV は header 行に "Order ID" + "Ship Date" + "Product Name" を含む
    return /Order ID/i.test(text) && /Ship Date/i.test(text) && /Product Name/i.test(text);
  },

  parse(buf: Buffer, opts?: { account?: string }): ImporterResult {
    const text = decodeBuffer(buf);
    const rows = parseCsv(text);
    if (rows.length === 0) return empty(opts);

    const header = rows[0]!.map((s) => s.trim());
    const findIdx = (...names: string[]) =>
      header.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase() || h.toLowerCase().includes(n.toLowerCase())));

    const I = {
      orderId: findIdx("order id"),
      orderDate: findIdx("order date"),
      currency: findIdx("currency"),
      unitPrice: findIdx("unit price"),
      unitTax: findIdx("unit price tax", "unit tax"),
      totalOwed: findIdx("total owed"),
      qty: findIdx("quantity"),
      orderStatus: findIdx("order status"),
      shipDate: findIdx("ship date"),
      productName: findIdx("product name"),
    };

    const warnings: string[] = [];
    const account = opts?.account ?? ACCOUNT_DEFAULT;

    if (I.orderId < 0 || I.totalOwed < 0 || I.productName < 0) {
      warnings.push("required columns (Order ID / Total Owed / Product Name) not found");
      return { brand: "amazon-order-history", account, rows: [], warnings };
    }

    // shipment 単位で集約
    const shipments = new Map<string, Shipment>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!;
      if (!r[I.orderId]) continue;
      const status = (r[I.orderStatus] ?? "").trim();
      if (/cancelled|canceled/i.test(status)) continue;

      const orderId = r[I.orderId]!.trim();
      const orderDate = I.orderDate >= 0 ? normalizeDate((r[I.orderDate] ?? "").trim()) : null;
      const shipDate = I.shipDate >= 0 ? normalizeDate((r[I.shipDate] ?? "").trim()) : null;
      // ship date 無し (digital / pending) は order date を fallback として使う
      const groupKey = `${orderId}|${shipDate ?? orderDate ?? "no-date"}`;

      const totalOwed = parseAmount(r[I.totalOwed]) ?? 0;
      const unitPrice = I.unitPrice >= 0 ? parseAmount(r[I.unitPrice]) ?? 0 : 0;
      const unitTax = I.unitTax >= 0 ? parseAmount(r[I.unitTax]) ?? 0 : 0;
      const qty = I.qty >= 0 ? (parseAmount(r[I.qty]) ?? 1) : 1;
      const product = (r[I.productName] ?? "").trim() || "(unknown product)";

      let s = shipments.get(groupKey);
      if (!s) {
        s = {
          order_id: orderId,
          order_date: orderDate,
          ship_date: shipDate,
          status,
          total: 0,
          items: [],
          card_hint: "",
        };
        shipments.set(groupKey, s);
      }
      s.total += totalOwed;
      s.items.push({
        product,
        total_owed: totalOwed,
        qty,
        unit_price: unitPrice,
        unit_tax: unitTax,
      });
    }

    const out: ImportedTransaction[] = [];
    for (const s of shipments.values()) {
      const date = s.ship_date ?? s.order_date;
      if (!date) {
        warnings.push(`order ${s.order_id}: 日付不明、 skip`);
        continue;
      }
      if (s.total === 0) continue;
      out.push({
        date,
        amount_in: null,
        amount_out: s.total,
        currency: "JPY",
        fx_amount: null,
        fx_currency: null,
        description: s.items.map((i) => i.product).join(" / ").slice(0, 1000),
        payee: "Amazon",
        source_id: stableId(s),
        account,
        metadata: {
          brand: "amazon-order-history",
          order_id: s.order_id,
          order_date: s.order_date,
          ship_date: s.ship_date,
          status: s.status,
          items: s.items,
        },
      });
    }

    return { brand: "amazon-order-history", account, rows: out, warnings };
  },
};

function empty(opts?: { account?: string }): ImporterResult {
  return {
    brand: "amazon-order-history",
    account: opts?.account ?? ACCOUNT_DEFAULT,
    rows: [],
    warnings: ["empty csv"],
  };
}

function stableId(s: Shipment): string {
  const h = createHash("sha1");
  h.update([s.order_id, s.ship_date ?? "", s.order_date ?? "", s.total, s.items.length].join("\x1f"));
  return `amazon:${h.digest("hex").slice(0, 16)}`;
}

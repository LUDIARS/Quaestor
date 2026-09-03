import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { applyMigrations } from "../src/db/schema.js";
import { buildMemoriaSpendingLog, classifyPurchase } from "../src/services/memoria-spending-log.js";

function insertTransaction(
  db: Database.Database,
  values: { id: string; date: string; amount: number; payee: string; account: string },
): void {
  db.prepare(
    `INSERT INTO transactions
     (id, date, amount_in, amount_out, currency, description, payee, source,
      source_id, account, import_id, metadata, is_transfer, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'JPY', ?, ?, 'credit-card', ?, ?, NULL, '{}', 0, 100, 100)`,
  ).run(values.id, values.date, values.amount, values.payee, values.payee, values.id, values.account);
}

function requestFromLoopback(
  app: ReturnType<typeof buildApp>,
  url: string,
): Promise<Response> {
  return Promise.resolve(app.request(url, undefined, {
    incoming: {
      socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 12345,
        remoteFamily: "IPv4",
      },
    },
  }));
}

describe("Memoria spending log export", () => {
  it("deduplicates a reconciled receipt and transaction in daily totals", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const rules = new ApportionmentRulesRepo(db);
    insertTransaction(db, {
      id: "tx-1",
      date: "2026-07-20",
      amount: 1_500,
      payee: "サンプルストア",
      account: "PayPay",
    });
    db.prepare(
      `INSERT INTO receipts
       (id, captured_at, image_path, ocr_status, date, payee, total, items, geo,
        ocr_raw, metadata, committed_at, created_at, updated_at)
       VALUES ('receipt-1', 100, NULL, 'done', '2026-07-20', 'サンプルストア', 1500,
        ?, '{"lat":35.6812,"lon":139.7671,"accuracy":12}', NULL, NULL, 101, 100, 101)`,
    ).run(JSON.stringify([
      { name: "コーヒー飲料", price: 500, qty: 1 },
      { name: "Tシャツ", price: 1000, qty: 1 },
    ]));
    db.prepare(
      `INSERT INTO reconciliations
       (receipt_id, transaction_id, matched_by, confidence, notes, created_at, updated_at)
       VALUES ('receipt-1', 'tx-1', 'manual', 1, NULL, 102, 102)`,
    ).run();

    const exported = buildMemoriaSpendingLog(db, rules, {
      dateFrom: "2026-07-20",
      dateTo: "2026-07-20",
    });

    expect(exported.records).toHaveLength(1);
    expect(exported.records[0]?.amount).toBe(1_500);
    expect(exported.records[0]?.payment).toEqual({ kind: "digital_wallet", label: "PayPay" });
    expect(exported.records[0]?.items.map((item) => item.category)).toEqual(["food", "clothing"]);
    expect(exported.records[0]?.purchase_category).toBe("undetermined");
    expect(exported.records[0]?.place.location?.latitude).toBe(35.6812);
    expect(exported.records[0]?.place.google_maps_url).toContain("35.6812%2C139.7671");
    expect(exported.daily_summaries[0]?.total_amount).toBe(1_500);
    expect(exported.daily_summaries[0]?.places[0]?.amount).toBe(1_500);
  });

  it("keeps an unmatched committed receipt and marks unknown attributes as undetermined", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const rules = new ApportionmentRulesRepo(db);
    db.prepare(
      `INSERT INTO receipts
       (id, captured_at, image_path, ocr_status, date, payee, total, items, geo,
        ocr_raw, metadata, committed_at, created_at, updated_at)
       VALUES ('receipt-2', 100, NULL, 'manual', '2026-07-21', '不明店', 700,
        '[{"name":"雑貨","price":700}]', NULL, NULL, NULL, 101, 100, 101)`,
    ).run();

    const exported = buildMemoriaSpendingLog(db, rules, {
      dateFrom: "2026-07-21",
      dateTo: "2026-07-21",
    });

    expect(exported.records).toHaveLength(1);
    expect(exported.records[0]?.source_kind).toBe("receipt");
    expect(exported.records[0]?.purchase_category).toBe("undetermined");
    expect(exported.records[0]?.expense.planned).toBeNull();
  });

  it("does not export a statement receipt in addition to its transaction rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const rules = new ApportionmentRulesRepo(db);
    db.prepare(
      `INSERT INTO receipts
       (id, captured_at, image_path, ocr_status, date, payee, total, doc_kind,
        committed_at, created_at, updated_at)
       VALUES ('statement-1', 100, NULL, 'done', '2026-07-21', 'カード明細', 700, 'statement',
        101, 100, 101)`,
    ).run();

    const exported = buildMemoriaSpendingLog(db, rules, {
      dateFrom: "2026-07-21",
      dateTo: "2026-07-21",
    });

    expect(exported.records).toEqual([]);
    expect(exported.daily_summaries).toEqual([]);
  });

  it("requires a direct loopback request for the export API", async () => {
    const app = buildApp({
      db: new Database(":memory:"),
      receiptsRoot: "/tmp/quaestor-memoria",
      ocr: "disabled",
    });
    const denied = await app.request(
      "/v1/integrations/memoria/spending-logs?date_from=2026-07-01&date_to=2026-07-31",
    );
    expect(denied.status).toBe(403);

    const allowed = await requestFromLoopback(
      app,
      "http://127.0.0.1/v1/integrations/memoria/spending-logs?date_from=2026-07-01&date_to=2026-07-31",
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Cache-Control")).toBe("no-store");
  });

  it("classifies only explicit purchase keywords", () => {
    expect(classifyPurchase("牛乳")).toBe("food");
    expect(classifyPurchase("スニーカー シューズ")).toBe("clothing");
    expect(classifyPurchase("ぬいぐるみ")).toBe("toy");
    expect(classifyPurchase("雑貨")).toBe("undetermined");
  });
});

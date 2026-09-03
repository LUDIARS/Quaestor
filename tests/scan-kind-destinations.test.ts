import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { applyMigrations } from "../src/db/schema.js";
import { CostRulesRepo } from "../src/db/cost-rules-repo.js";
import { ImportsRepo } from "../src/db/imports-repo.js";
import { InboundDocumentsRepo } from "../src/db/inbound-documents-repo.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.js";
import { commitReceipt, commitReasonCode } from "../src/services/receipt-commit.js";
import { createKindDestinations } from "../src/services/receipt-kind-destinations.js";
import { ReceiptIntake } from "../src/services/receipt-intake.js";
import { CostStructureService } from "../src/services/cost-structure/cost-structure.js";
import { inferUtilityKind, utilitySupplierPattern } from "../src/services/cost-structure/utility-supplier-rules.js";
import { invoiceExtraction } from "../src/services/scan-invoice-intake.js";
import { statementDuplicateKey, kindDuplicateKey } from "../src/services/receipt-duplicate-keys.js";
import { statementRowSourceId } from "../src/services/statement-rows.js";
import type { KindFields } from "../src/shared/receipt-kind-fields.js";
import type { DocKind } from "../src/shared/document-kinds.js";
import type { PdfExtraction } from "../src/mail/pdf-extract.js";

/**
 * 書類種別ごとの投入先配線 (spec/feature/scan-document-kinds.md SPEC-SCAN-KIND-005)。
 *  - invoice  → inbound_documents (メール取込と同じ受領書類の形)
 *  - utility  → cost_rules → 水道光熱費ビュー (月 × 種別)
 *  - statement → imports + transactions (明細取込と同じ取引)
 *  - other だけが要確認に残る
 */

interface Harness {
  db: Database.Database;
  receipts: ReceiptsRepo;
  documents: InboundDocumentsRepo;
  costRules: CostRulesRepo;
  imports: ImportsRepo;
  txs: TransactionsRepo;
  destinations: ReturnType<typeof createKindDestinations>;
}

function harness(): Harness {
  const db = new Database(":memory:");
  applyMigrations(db);
  const receipts = new ReceiptsRepo(db);
  const documents = new InboundDocumentsRepo(db);
  const costRules = new CostRulesRepo(db);
  costRules.seedIfEmpty();
  const imports = new ImportsRepo(db);
  const txs = new TransactionsRepo(db);
  const destinations = createKindDestinations({
    db, documents, costRules, imports, txs, today: () => "2026-09-03",
  });
  return { db, receipts, documents, costRules, imports, txs, destinations };
}

interface SeedInput {
  date?: string | null;
  payee?: string | null;
  total?: number | null;
  kind_fields?: KindFields | null;
}

function seed(h: Harness, kind: DocKind, input: SeedInput = {}): string {
  const id = h.receipts.insert({ image_path: `2026/08/${Math.random().toString(16).slice(2)}.jpg` });
  h.receipts.setOcrResult(id, {
    ocr_status: "done",
    date: input.date === undefined ? "2026-08-20" : input.date,
    payee: input.payee === undefined ? "テスト発行者" : input.payee,
    total: input.total === undefined ? 8420 : input.total,
  });
  h.receipts.setLabels(id, { doc_kind: kind, kind_fields: input.kind_fields ?? null, sample_source: "llm" });
  return id;
}

describe("invoice: 受領書類 (inbound_documents) へ合流する", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  it("投入すると PdfExtraction と同じ形で受領書類に載り、 レシートも投入済になる", () => {
    const id = seed(h, "invoice", {
      payee: "ACME 商事",
      total: 33000,
      kind_fields: { issuer: "ACME 商事", due_date: "2026-09-30", invoice_no: "INV-7" },
    });

    const out = commitReceipt(h.receipts, id, { trigger: "auto", destinations: h.destinations });
    expect(out.ok).toBe(true);
    expect(h.receipts.find(id)!.committed_at).not.toBeNull();

    const doc = h.documents.findByReceipt(id)!;
    expect(doc.source).toBe("scan");
    expect(doc.message_id).toBeNull();
    expect(doc.sha256).toBeNull();
    expect(doc.status).toBe("committed");
    expect(doc.mime_type).toBe("image/jpeg");
    const extracted = JSON.parse(doc.extracted!) as PdfExtraction;
    expect(extracted).toEqual({
      issuer: "ACME 商事", date: "2026-08-20", total: 33000,
      due_date: "2026-09-30", invoice_no: "INV-7", confidence: "high",
    });
    // メール取込の受領一覧に混ざって出る
    expect(h.documents.list("committed").map((d) => d.id)).toContain(doc.id);
  });

  it("issuer が無ければ incomplete (要確認に残る)", () => {
    const id = seed(h, "invoice", { payee: "  ", kind_fields: { issuer: null, due_date: null, invoice_no: null } });
    expect(commitReceipt(h.receipts, id, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "incomplete", missing: ["issuer"] });
    expect(h.receipts.find(id)!.committed_at).toBeNull();
  });

  it("issuer + invoice_no が同じ請求書は日付や金額が違っても duplicate", () => {
    const fields = { issuer: "ACME 商事", due_date: null, invoice_no: "INV-7" };
    const first = seed(h, "invoice", { payee: "ACME 商事", kind_fields: fields });
    expect(commitReceipt(h.receipts, first, { destinations: h.destinations }).ok).toBe(true);

    const again = seed(h, "invoice", {
      date: "2026-08-25", payee: "ａｃｍｅ 商事", total: 99999, kind_fields: fields,
    });
    const out = commitReceipt(h.receipts, again, { destinations: h.destinations });
    expect(out).toMatchObject({ ok: false, reason: "duplicate", existingId: first });
    expect(commitReasonCode(out)).toBe("duplicate");
    expect(h.documents.findByReceipt(again)).toBeUndefined();
  });

  it("請求番号が読めなかった請求書は 日付-発行者-金額 で重複を見る", () => {
    const fields = { issuer: "ACME 商事", due_date: null, invoice_no: null };
    const first = seed(h, "invoice", { payee: null, kind_fields: fields });
    expect(commitReceipt(h.receipts, first, { destinations: h.destinations }).ok).toBe(true);
    const same = seed(h, "invoice", { payee: "OCR 表記は異なる", kind_fields: fields });
    expect(commitReceipt(h.receipts, same, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "duplicate", existingId: first });
  });

  it("invoiceExtraction は発行者 / 日付 / 金額が欠ければ confidence=low", () => {
    const id = seed(h, "invoice", { total: null, kind_fields: { issuer: "X", due_date: null, invoice_no: null } });
    expect(invoiceExtraction(h.receipts.find(id)!).confidence).toBe("low");
  });
});

describe("utility: cost_rules を通して水道光熱費ビューに載る", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  const METER = {
    supplier: "みらいエナジー", period_from: "2026-07-15", period_to: "2026-08-14", usage: "312 kWh",
  };

  function utilityView(anchor = "2026-08-31") {
    const service = new CostStructureService({
      db: h.db, rules: h.costRules, apportionment: new ApportionmentRulesRepo(h.db),
    });
    return service.utilities(anchor, 12);
  }

  it("検針票の供給者が cost_rules に入り、 月 × 種別のビューに金額が出る", () => {
    expect(utilityView().kinds.find((k) => k.kind === "electric")!.total_12m).toBe(0);

    const id = seed(h, "utility", { payee: "みらいエナジー", total: 8420, kind_fields: METER });
    const out = commitReceipt(h.receipts, id, { trigger: "auto", destinations: h.destinations });
    expect(out.ok).toBe(true);
    expect(out.ok && out.delivery).toMatchObject({ kind: "utility", detail: { utility: "electric", rule_created: true } });

    // cost_rules に供給者が入る (検針票由来と分かる note 付き)
    const rule = h.costRules.list().find((r) => r.note === "utility-scan:2026-09-03")!;
    expect(rule).toMatchObject({ cost_type: "fixed", utility: "electric", label: "みらいエナジー" });
    expect(h.costRules.resolve("みらいエナジー").utility).toBe("electric");

    // 水道光熱費ビュー (月 × 種別)
    const view = utilityView();
    const electric = view.kinds.find((k) => k.kind === "electric")!;
    expect(electric.latest_month).toBe("2026-08");
    expect(electric.latest_amount).toBe(8420);
    expect(electric.payees).toContain("みらいエナジー");
    expect(view.months.find((m) => m.month === "2026-08")!.by_kind.electric).toBe(8420);
    expect(view.total_12m).toBe(8420);
  });

  it("seed 済の供給者ならルールを増やさず、 既存の種別をそのまま使う", () => {
    const before = h.costRules.list().length;
    const id = seed(h, "utility", {
      payee: "東京電力", total: 7000,
      kind_fields: { supplier: "東京電力", period_from: "2026-07-15", period_to: "2026-08-14", usage: "200 kWh" },
    });
    const out = commitReceipt(h.receipts, id, { destinations: h.destinations });
    expect(out.ok && out.delivery?.detail).toMatchObject({ utility: "electric", rule_created: false });
    expect(h.costRules.list().length).toBe(before);
    expect(utilityView().kinds.find((k) => k.kind === "electric")!.latest_amount).toBe(7000);
  });

  it("種別を推定できない供給者でも投入はする (ルールは作らない)", () => {
    const id = seed(h, "utility", {
      payee: "きさらぎ商会", total: 3000,
      kind_fields: { supplier: "きさらぎ商会", period_from: "2026-07-15", period_to: "2026-08-14", usage: null },
    });
    const out = commitReceipt(h.receipts, id, { destinations: h.destinations });
    expect(out.ok).toBe(true);
    expect(out.ok && out.delivery?.detail).toMatchObject({ cost_rule_id: null, reason: "unknown_kind" });
    expect(h.receipts.find(id)!.committed_at).not.toBeNull();
  });

  it("supplier + 使用期間が同じ検針票は duplicate", () => {
    const first = seed(h, "utility", { payee: "みらいエナジー", kind_fields: METER });
    expect(commitReceipt(h.receipts, first, { destinations: h.destinations }).ok).toBe(true);
    const again = seed(h, "utility", { date: "2026-08-22", payee: "みらいエナジー", total: 8500, kind_fields: METER });
    expect(commitReceipt(h.receipts, again, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "duplicate", existingId: first });
  });

  it("inferUtilityKind: 供給者名を先に見て、 無ければ使用量の単位で決める", () => {
    expect(inferUtilityKind("東京ガス", "12 m3")).toBe("gas");
    expect(inferUtilityKind("みらいエナジー", "312 kWh")).toBe("electric");
    expect(inferUtilityKind("市水道局", null)).toBe("water");
    expect(inferUtilityKind("みらい商会", "12 m3")).toBeNull(); // m3 だけではガス / 水道を決められない
    expect(inferUtilityKind(null, null)).toBeNull();
  });

  it("utilitySupplierPattern は供給者と payee の両方に当たる (重複は畳む)", () => {
    expect(utilitySupplierPattern(["東京電力", "東京電力"])).toBe("^(?:東京電力)$");
    expect(utilitySupplierPattern(["A.B", "C"])).toBe("^(?:A\\.B|C)$");
    expect(utilitySupplierPattern([null, "  "])).toBeNull();
  });
});

describe("statement: 明細取込と同じ取引として入る", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  const ROWS = {
    rows: [
      { date: "2026-08-01", description: "セブンイレブン", amount: 540 },
      { date: "2026-08-03", description: "AMAZON.CO.JP", amount: 2980 },
      { date: "2026-08-05", description: "カード払い戻し", amount: -1200 },
      { date: null, description: "日付不明", amount: 100 },
    ],
  };

  it("kind_fields.rows[] が transactions に入り、 出金 / 入金の符号が付く", () => {
    const id = seed(h, "statement", { payee: "SMBC NL", total: null, kind_fields: ROWS });
    const out = commitReceipt(h.receipts, id, { trigger: "auto", destinations: h.destinations });
    expect(out.ok).toBe(true);
    expect(out.ok && out.delivery?.detail).toMatchObject({ parsed: 3, inserted: 3, duplicates: 0, account: "SMBC NL" });
    expect(h.receipts.find(id)!.committed_at).not.toBeNull();

    const rows = h.txs.list({ account: "SMBC NL" });
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.description === "セブンイレブン")).toMatchObject({ amount_out: 540, amount_in: null });
    expect(rows.find((r) => r.description === "カード払い戻し")).toMatchObject({ amount_out: null, amount_in: 1200 });
    // source_id は明細取込 (smart-import) と同じ規則
    expect(rows.find((r) => r.description === "セブンイレブン")!.source_id).toBe(
      statementRowSourceId("SMBC NL", { date: "2026-08-01", description: "セブンイレブン", amount_out: 540, amount_in: null }),
    );
    expect(h.imports.list().find((i) => i.brand === "scan-statement")).toBeTruthy();
  });

  it("同じ明細をもう一度撮ると duplicate で弾く", () => {
    const first = seed(h, "statement", { payee: "SMBC NL", total: null, kind_fields: ROWS });
    expect(commitReceipt(h.receipts, first, { destinations: h.destinations }).ok).toBe(true);
    const again = seed(h, "statement", { payee: "SMBC NL", total: null, kind_fields: ROWS });
    expect(commitReceipt(h.receipts, again, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "duplicate", existingId: first });
    expect(h.txs.list({ account: "SMBC NL" }).length).toBe(3);
  });

  it("取り込める行が無ければ incomplete", () => {
    const id = seed(h, "statement", { payee: "SMBC NL", total: null, kind_fields: { rows: [] } });
    expect(commitReceipt(h.receipts, id, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "incomplete", missing: ["rows"] });
    expect(statementDuplicateKey(h.receipts.find(id)!)).toBeNull();
    expect(kindDuplicateKey(h.receipts.find(id)!)).toBeNull();
  });

  it("暦日として不正な日付や安全な整数範囲外の金額は取り込まない", () => {
    const id = seed(h, "statement", {
      payee: "SMBC NL",
      total: null,
      kind_fields: {
        rows: [
          { date: "2026-02-30", description: "存在しない日", amount: 100 },
          { date: "2026-08-01", description: "巨大な金額", amount: Number.MAX_SAFE_INTEGER + 1 },
        ],
      },
    });
    expect(commitReceipt(h.receipts, id, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "incomplete", missing: ["rows"] });
  });

  it("明細レシートは家計の支出イベントにも突合にも入らない (行が transactions 側にあるため)", () => {
    const id = seed(h, "statement", { payee: "SMBC NL", total: 4720, kind_fields: ROWS });
    expect(commitReceipt(h.receipts, id, { destinations: h.destinations }).ok).toBe(true);

    const service = new CostStructureService({
      db: h.db, rules: h.costRules, apportionment: new ApportionmentRulesRepo(h.db),
    });
    const view = service.view("month", "2026-08-31");
    // 取引 3 件のうち出金は 2 件。 明細レシート自身 (4720) は数えない
    expect(view.totals.spend).toBe(540 + 2980);

    const intake = new ReceiptIntake({
      db: h.db, receipts: h.receipts, reconciliations: new ReconciliationsRepo(h.db), destinations: h.destinations,
    });
    expect(intake.afterCommit(id)!.matched).toEqual([]);
    expect(intake.afterCommit(id)!.skipped).toEqual([]);
  });
});

describe("other / handwritten: 要確認に残す既存挙動", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  it("other は投入先が無いので auto / manual とも要確認に残る", () => {
    const id = seed(h, "other");
    for (const trigger of ["auto", "manual"] as const) {
      const out = commitReceipt(h.receipts, id, { trigger, destinations: h.destinations });
      expect(commitReasonCode(out)).toBe("kind_not_auto_committed:other");
    }
    expect(h.receipts.find(id)!.committed_at).toBeNull();
  });

  it("handwritten は投入先を配線しても auto は needs_review、 manual は投入できる", () => {
    const id = seed(h, "handwritten", { payee: "手書き商店", total: 500 });
    const auto = commitReceipt(h.receipts, id, { trigger: "auto", destinations: h.destinations });
    expect(commitReasonCode(auto)).toBe("needs_review");
    expect(h.receipts.find(id)!.committed_at).toBeNull();

    const manual = commitReceipt(h.receipts, id, { trigger: "manual", destinations: h.destinations });
    expect(manual.ok).toBe(true);
    expect(h.documents.findByReceipt(id)).toBeUndefined();
    expect(h.imports.list().length).toBe(0);
  });

  it("receipt は日付-場所-金額の完備 / 重複判定のまま", () => {
    const first = seed(h, "receipt", { payee: "カスミ 志木店", total: 1200 });
    expect(commitReceipt(h.receipts, first, { trigger: "auto", destinations: h.destinations }).ok).toBe(true);
    const dup = seed(h, "receipt", { payee: "カスミ　志木店", total: 1200 });
    expect(commitReceipt(h.receipts, dup, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "duplicate", existingId: first });
    const missing = seed(h, "receipt", { total: null });
    expect(commitReceipt(h.receipts, missing, { destinations: h.destinations }))
      .toMatchObject({ ok: false, reason: "incomplete", missing: ["total"] });
  });
});

describe("schema v20: inbound_documents をスキャン由来にも開く", () => {
  it("v19 の行を source='mail' で残したまま message_id / sha256 を NULL 可にする", () => {
    const db = new Database(":memory:");
    try {
      // v19 相当 (メール専用の形)
      db.exec(`CREATE TABLE mail_messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT, received_at INTEGER NOT NULL,
        from_address TEXT NOT NULL, subject TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('invoice','cloud_notice','ignore')),
        rule_index INTEGER, outcome TEXT NOT NULL, error TEXT, processed_at INTEGER NOT NULL
      )`);
      db.exec(`CREATE TABLE inbound_documents (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES mail_messages(message_id) ON DELETE CASCADE,
        filename TEXT NOT NULL, mime_type TEXT NOT NULL, file_path TEXT NOT NULL, sha256 TEXT NOT NULL,
        size INTEGER NOT NULL, extracted TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','needs_review','ignored')),
        receipt_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      db.exec("CREATE UNIQUE INDEX idx_inbound_sha ON inbound_documents(sha256)");
      db.prepare(
        `INSERT INTO mail_messages (message_id, received_at, from_address, subject, kind, outcome, processed_at)
         VALUES ('m1', 1, 'a@example.com', 's', 'invoice', 'ok', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO inbound_documents (id, message_id, filename, mime_type, file_path, sha256, size, status, created_at, updated_at)
         VALUES ('d1', 'm1', 'a.pdf', 'application/pdf', '2026/08/d1.pdf', 'deadbeef', 10, 'needs_review', 1, 1)`,
      ).run();
      db.pragma("user_version = 19");

      applyMigrations(db);
      applyMigrations(db); // 冪等

      const repo = new InboundDocumentsRepo(db);
      const legacy = repo.find("d1")!;
      expect(legacy).toMatchObject({ source: "mail", message_id: "m1", sha256: "deadbeef", status: "needs_review" });

      const receiptRepo = new ReceiptsRepo(db);
      const firstReceiptId = receiptRepo.insert({ image_path: "2026/08/x.jpg" });
      const scanId = repo.insert({
        source: "scan", message_id: null, filename: "x.jpg", mime_type: "image/jpeg",
        file_path: "2026/08/x.jpg", sha256: null, size: 0, extracted: null, status: "committed",
        receipt_id: firstReceiptId,
      });
      expect(repo.find(scanId)).toMatchObject({ source: "scan", message_id: null, sha256: null });
      expect(() => repo.insert({
        filename: "bad.pdf", mime_type: "application/pdf", file_path: "2026/08/bad.pdf",
        message_id: "", sha256: "", size: 0, extracted: null, status: "needs_review",
      })).toThrow(/require message_id and sha256/);
      // sha256 NULL は UNIQUE 制約に引っ掛からない (scan を何件でも登録できる)
      const secondReceiptId = receiptRepo.insert({ image_path: "2026/08/y.jpg" });
      expect(() => repo.insert({
        source: "scan", message_id: null, filename: "y.jpg", mime_type: "image/jpeg",
        file_path: "2026/08/y.jpg", sha256: null, size: 0, extracted: null, status: "committed",
        receipt_id: secondReceiptId,
      })).not.toThrow();
      expect(db.pragma("user_version", { simple: true })).toBe(20);
    } finally {
      db.close();
    }
  });
});

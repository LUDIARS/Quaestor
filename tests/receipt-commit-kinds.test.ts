import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo, type ReceiptRow } from "../src/db/receipts-repo.js";
import { commitReceipt, commitReasonCode, kindBlockMessage } from "../src/services/receipt-commit.js";
import {
  receiptDuplicateKey, invoiceDuplicateKey, utilityDuplicateKey, kindDuplicateKey,
} from "../src/services/receipt-duplicate-keys.js";
import { normalizeLlmLabels, applyLlmLabels, applyManualLabels } from "../src/services/receipt-labels.js";
import { buildPrompt } from "../src/services/claude-code-ocr.js";
import { buildLabelOnlyPrompt, classificationPromptSection } from "../src/services/ocr-classification-prompt.js";
import { claudeCliArgs } from "../src/services/claude-cli.js";
import { DOC_KINDS, DOC_KIND_INFO, SAMPLE_ROLES, normalizeTagList } from "../src/shared/document-kinds.js";
import { normalizeKindFields } from "../src/shared/receipt-kind-fields.js";

/**
 * 投入ゲートの種別分岐・重複キー・ラベル正規化・prompt の語彙整合 (spec/feature/scan-document-kinds.md)。
 */

describe("receipt-commit: 書類種別による投入ゲート", () => {
  let db: Database.Database;
  let repo: ReceiptsRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new ReceiptsRepo(db);
  });

  function seed(kind: ReceiptRow["doc_kind"], fields = { date: "2026-04-15", payee: "STORE", total: 500 }): string {
    const id = repo.insert({});
    repo.setOcrResult(id, { ocr_status: "done", ...fields });
    repo.setLabels(id, { doc_kind: kind, sample_source: "llm" });
    return id;
  }

  it("receipt は auto / manual とも現行ルールで投入される", () => {
    const id = seed("receipt");
    const auto = commitReceipt(repo, id, { trigger: "auto" });
    expect(auto.ok).toBe(true);
    const again = commitReceipt(repo, id, { trigger: "manual" });
    expect(again).toMatchObject({ ok: true, already: true });
  });

  it("handwritten は auto で needs_review、 manual では投入される", () => {
    const id = seed("handwritten");
    const auto = commitReceipt(repo, id, { trigger: "auto" });
    expect(auto).toMatchObject({ ok: false, reason: "needs_review", kind: "handwritten" });
    expect(commitReasonCode(auto)).toBe("needs_review");
    expect(repo.find(id)!.committed_at).toBeNull();

    const manual = commitReceipt(repo, id, { trigger: "manual" });
    expect(manual.ok).toBe(true);
    expect(repo.find(id)!.committed_at).not.toBeNull();
  });

  it("handwritten の手動投入も完備・重複の判定は通す", () => {
    const missing = seed("handwritten", { date: "2026-04-15", payee: "", total: 500 } as never);
    expect(commitReceipt(repo, missing)).toMatchObject({ ok: false, reason: "incomplete" });

    const first = seed("receipt");
    commitReceipt(repo, first);
    const dup = seed("handwritten");
    expect(commitReceipt(repo, dup)).toMatchObject({ ok: false, reason: "duplicate", existingId: first });
  });

  it("other は auto / manual とも kind_not_auto_committed:other (投入先が無い)", () => {
    const id = seed("other");
    for (const trigger of ["auto", "manual"] as const) {
      const out = commitReceipt(repo, id, { trigger });
      expect(out).toMatchObject({ ok: false, reason: "kind_not_auto_committed", kind: "other" });
      expect(commitReasonCode(out)).toBe("kind_not_auto_committed:other");
    }
    expect(repo.find(id)!.committed_at).toBeNull();
    expect(kindBlockMessage("other")).toContain(DOC_KIND_INFO.other.label);
  });

  it("投入先を渡さなければ invoice / utility / statement も投入しない (既定は receipts のみ)", () => {
    for (const kind of ["invoice", "utility", "statement"] as const) {
      const id = seed(kind);
      expect(commitReceipt(repo, id)).toMatchObject({ ok: false, reason: "kind_not_auto_committed", kind });
      expect(repo.find(id)!.committed_at).toBeNull();
    }
  });

  it("trigger 未指定は manual として扱う (API の既定)", () => {
    const id = seed("handwritten");
    expect(commitReceipt(repo, id).ok).toBe(true);
  });
});

describe("receipt-duplicate-keys: 種別ごとの重複キー", () => {
  const base = {
    id: "r", captured_at: 0, image_path: null, ocr_status: "done" as const, date: "2026-04-15", payee: "カスミ 志木店",
    total: 1200, items: null, geo: null, ocr_raw: null, metadata: null, committed_at: null, created_at: 0, updated_at: 0,
    doc_kind: "receipt" as const, kind_fields: null, sample_role: null, sample_tags: null, sample_reason: null,
    sample_source: null, content_tags: null,
  };

  it("receipt: 日付-場所-金額 (payee は normalizePayee: 全角 ASCII / 空白 / 大文字小文字を寄せる)、 欠けたら null", () => {
    expect(receiptDuplicateKey(base)).toBe(receiptDuplicateKey({ ...base, payee: "カスミ　志木店 " }));
    expect(receiptDuplicateKey({ ...base, payee: "Store A" })).toBe(receiptDuplicateKey({ ...base, payee: "ＳＴＯＲＥ　a" }));
    expect(receiptDuplicateKey({ ...base, total: null })).toBeNull();
    expect(receiptDuplicateKey({ ...base, payee: " " })).toBeNull();
  });

  it("invoice: issuer + invoice_no、 番号が無ければ null", () => {
    const inv = { ...base, doc_kind: "invoice" as const, kind_fields: JSON.stringify({ issuer: " acme ", invoice_no: "INV-7" }) };
    expect(invoiceDuplicateKey(inv)).toBe("ACME|INV-7");
    expect(invoiceDuplicateKey({ ...inv, kind_fields: JSON.stringify({ issuer: "ＡＣＭＥ", invoice_no: "ｉｎｖ－７" }) }))
      .toBe("ACME|INV-7");
    expect(invoiceDuplicateKey({ ...inv, kind_fields: JSON.stringify({ issuer: "ACME" }) })).toBeNull();
    expect(invoiceDuplicateKey(base)).toBeNull(); // 種別違い
  });

  it("utility: supplier + 使用期間、 期間が欠ければ null", () => {
    const u = {
      ...base, doc_kind: "utility" as const,
      kind_fields: JSON.stringify({ supplier: "東京電力", period_from: "2026-07-15", period_to: "2026-08-14" }),
    };
    expect(utilityDuplicateKey(u)).toBe("東京電力|2026-07-15..2026-08-14");
    expect(utilityDuplicateKey({ ...u, kind_fields: JSON.stringify({ supplier: "東京電力", period_from: "2026-07-15" }) })).toBeNull();
  });

  it("kindDuplicateKey は種別で振り分け、 statement / other は null", () => {
    expect(kindDuplicateKey(base)).toBe(receiptDuplicateKey(base));
    expect(kindDuplicateKey({ ...base, doc_kind: "handwritten" })).toBe(receiptDuplicateKey(base));
    expect(kindDuplicateKey({ ...base, doc_kind: "statement" })).toBeNull();
    expect(kindDuplicateKey({ ...base, doc_kind: "other" })).toBeNull();
  });
});

describe("receipt-labels: LLM 出力の正規化と適用", () => {
  it("語彙外の kind は null、 sample.role が語彙外なら sample だけ落とす", () => {
    expect(normalizeLlmLabels({ kind: "menu" })).toBeNull();
    expect(normalizeLlmLabels("receipt")).toBeNull();
    const only = normalizeLlmLabels({ kind: "receipt", sample: { role: "great", tags: ["long"] } });
    expect(only).toEqual({ kind: "receipt", kind_fields: null, sample: null, content_tags: [] });
    const noShapeTag = normalizeLlmLabels({ kind: "receipt", sample: { role: "special_shape", tags: [] } });
    expect(noShapeTag).toEqual({ kind: "receipt", kind_fields: null, sample: null, content_tags: [] });
  });

  it("タグは snake_case に寄せ、 不正・重複を落とし、 reason は 200 文字で切る", () => {
    expect(normalizeTagList(["Long", "multi-column", "long", "bad tag!", 3, "Low Light"])).toEqual(["long", "multi_column", "low_light"]);
    const out = normalizeLlmLabels({
      kind: "invoice",
      kind_fields: { issuer: " ACME ", due_date: "2026/09/30", invoice_no: "A-1", extra: true },
      sample: { role: "good_sample", tags: [], reason: "x".repeat(300) },
      content_tags: ["business"],
    })!;
    expect(out.kind_fields).toEqual({ issuer: "ACME", due_date: null, invoice_no: "A-1" });
    expect(out.sample!.reason).toHaveLength(200);
    expect(out.content_tags).toEqual(["business"]);
  });

  it("normalizeKindFields: statement は rows を整数化し、 receipt は null", () => {
    expect(normalizeKindFields("statement", {
      rows: [
        { date: "2026-01-02", description: "A", amount: "1,200円" },
        { date: null, description: "金額なし", amount: " 円 " },
        "junk",
      ],
    })).toEqual({
      rows: [
        { date: "2026-01-02", description: "A", amount: 1200 },
        { date: null, description: "金額なし", amount: null },
      ],
    });
    expect(normalizeKindFields("receipt", { anything: 1 })).toBeNull();
    expect(normalizeKindFields("utility", null)).toEqual({ supplier: null, period_from: null, period_to: null, usage: null });
  });

  it("applyManualLabels は manual を残し、 applyLlmLabels はそれを尊重する", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ReceiptsRepo(db);
    const id = repo.insert({});

    expect(applyManualLabels(repo, id, {})).toEqual({ applied: false, reason: "empty" });
    expect(applyManualLabels(repo, "nope", { doc_kind: "receipt" })).toEqual({ applied: false, reason: "not_found" });
    expect(applyManualLabels(repo, id, { sample_role: "none" })).toEqual({ applied: true, source: "manual" });
    expect(repo.find(id)!.sample_source).toBe("manual");

    const llm = applyLlmLabels(repo, id, { kind: "other", kind_fields: null, sample: { role: "good_sample", tags: [], reason: null }, content_tags: [] });
    expect(llm).toEqual({ applied: false, reason: "manual_override" });
    expect(repo.find(id)!.doc_kind).toBe("receipt");
    expect(repo.find(id)!.sample_role).toBe("none");
    db.close();
  });

  it("special_shape は有効な形状タグを 1 つ以上必要とする", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ReceiptsRepo(db);
    const id = repo.insert({});

    expect(applyManualLabels(repo, id, { sample_role: "special_shape", sample_tags: [] }))
      .toEqual({ applied: false, reason: "special_shape_requires_tag" });
    expect(applyManualLabels(repo, id, { sample_tags: ["Folded"] })).toEqual({ applied: true, source: "manual" });
    expect(applyManualLabels(repo, id, { sample_role: "special_shape" })).toEqual({ applied: true, source: "manual" });
    expect(applyManualLabels(repo, id, { sample_tags: [] }))
      .toEqual({ applied: false, reason: "special_shape_requires_tag" });
    db.close();
  });
});

describe("prompt / CLI 引数: 語彙が揃っている", () => {
  it("OCR prompt に 6 種の kind と 3 値の sample role、 PATCH 例に kind / sample が載る", () => {
    const p = buildPrompt("rid-1", "http://127.0.0.1:17400");
    for (const k of DOC_KINDS) expect(p).toContain(`\`${k}\``);
    for (const r of SAMPLE_ROLES) expect(p).toContain(`\`${r}\``);
    expect(p).toContain("\"kind\": \"receipt\"");
    expect(p).toContain("\"sample\": {");
    expect(p).toContain("\"content_tags\"");
    expect(p).toContain(classificationPromptSection());
  });

  it("後付け prompt は画像パスを含み、 fields 抽出をさせない", () => {
    const p = buildLabelOnlyPrompt("E:/data/receipts/2026/06/x.jpg");
    expect(p).toContain("E:/data/receipts/2026/06/x.jpg");
    for (const k of DOC_KINDS) expect(p).toContain(`\`${k}\``);
    expect(p).toContain("抽出はしない");
    expect(p).not.toContain("PATCH");
  });

  it("claudeCliArgs: model と allowedTools を安全な形だけ渡す", () => {
    expect(claudeCliArgs({})).toEqual(["-p", "--output-format", "json"]);
    expect(claudeCliArgs({ model: "sonnet", allowedTools: ["Read"] }))
      .toEqual(["-p", "--output-format", "json", "--model", "sonnet", "--allowedTools", "Read"]);
    expect(claudeCliArgs({ model: "sonnet; rm -rf /", allowedTools: ["Read", "Bash(rm *)"] }))
      .toEqual(["-p", "--output-format", "json", "--allowedTools", "Read"]);
    expect(claudeCliArgs({ model: null })).toEqual(["-p", "--output-format", "json"]);
  });
});

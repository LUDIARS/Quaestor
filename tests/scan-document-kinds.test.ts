import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";

/**
 * 書類種別 (doc_kind) と LLM サンプルラベル (spec/feature/scan-document-kinds.md)。
 *  - schema v19 の migration (新規 / 既存 DB)
 *  - PATCH /ocr の新旧 payload、 PATCH /labels の人手上書き
 *  - 投入ゲートの種別分岐 (API 経由)
 */

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

const RECEIPT_COLUMNS_V19 = [
  "doc_kind", "kind_fields", "sample_role", "sample_tags", "sample_reason", "sample_source", "content_tags",
];

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

describe("schema v19: receipts の書類種別 / サンプルラベル列", () => {
  it("新規 DB に 7 列と index が出来て user_version が 21 になる", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      expect(columnNames(db, "receipts")).toEqual(expect.arrayContaining(RECEIPT_COLUMNS_V19));
      expect(db.pragma("user_version", { simple: true })).toBe(21);
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='receipts'").all() as { name: string }[];
      expect(idx.map((i) => i.name)).toEqual(expect.arrayContaining(["idx_receipts_doc_kind", "idx_receipts_sample_role"]));
    } finally {
      db.close();
    }
  });

  it("v18 以前の receipts 行を保持したまま列を足し、 既存行は doc_kind='receipt' / sample_role NULL になる", () => {
    const db = new Database(":memory:");
    try {
      // v18 相当: 新列を持たない receipts と既存 1 行
      db.exec(`CREATE TABLE receipts (
        id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL, image_path TEXT,
        ocr_status TEXT NOT NULL DEFAULT 'pending', date TEXT, payee TEXT, total INTEGER, items TEXT,
        geo TEXT, ocr_raw TEXT, metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        committed_at INTEGER
      )`);
      db.prepare(
        `INSERT INTO receipts (id, captured_at, ocr_status, date, payee, total, created_at, updated_at, committed_at)
         VALUES ('legacy', 1, 'done', '2026-06-01', 'カスミ', 1200, 1, 1, 2)`,
      ).run();
      db.pragma("user_version = 18");

      applyMigrations(db);
      applyMigrations(db); // 冪等

      expect(columnNames(db, "receipts")).toEqual(expect.arrayContaining(RECEIPT_COLUMNS_V19));
      const row = new ReceiptsRepo(db).find("legacy")!;
      expect(row.doc_kind).toBe("receipt");
      expect(row.sample_role).toBeNull();
      expect(row.sample_source).toBeNull();
      expect(row.committed_at).toBe(2);
      expect(db.pragma("user_version", { simple: true })).toBe(21);
      // CHECK 制約が効く
      expect(() => db.prepare("UPDATE receipts SET doc_kind = 'menu' WHERE id = 'legacy'").run()).toThrow();
      expect(() => db.prepare("UPDATE receipts SET sample_role = 'great' WHERE id = 'legacy'").run()).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("API: 書類種別 / サンプルラベル", () => {
  let db: Database.Database;
  let app: ReturnType<typeof buildApp>;
  let receiptsRoot: string;
  let receipts: ReceiptsRepo;
  let seq = 0;

  beforeEach(() => {
    receiptsRoot = mkdtempSync(join(tmpdir(), "quaestor-kinds-"));
    db = new Database(":memory:");
    app = buildApp({ db, receiptsRoot });
    receipts = new ReceiptsRepo(db);
  });
  afterEach(() => { rmSync(receiptsRoot, { recursive: true, force: true }); });

  async function createReceipt(): Promise<string> {
    seq++;
    const buf = Buffer.from(PNG_1x1, "base64");
    buf[buf.length - 1] = seq % 256; // image-hash dedup を避ける
    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: buf.toString("base64"), ext: "png" }),
    });
    return ((await res.json()) as { receipt: { id: string } }).receipt.id;
  }

  async function patchJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("旧 payload (kind 無し) の PATCH /ocr は従来どおり通り、 ラベルは触らない", async () => {
    const id = await createReceipt();
    const { status, json } = await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "サイゼリヤ", total: 1820,
    });
    expect(status).toBe(200);
    expect(json.labels).toBeNull();
    expect(json.auto_commit).toEqual({ committed: true, already: false });
    const row = receipts.find(id)!;
    expect(row.doc_kind).toBe("receipt");
    expect(row.sample_role).toBeNull();
  });

  it("新 payload の PATCH /ocr は種別・kind_fields・sample・content_tags を llm ラベルとして保存する", async () => {
    const id = await createReceipt();
    const { status, json } = await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-08-20", payee: "東京電力", total: 8420,
      kind: "utility",
      kind_fields: { supplier: "東京電力", period_from: "2026-07-15", period_to: "2026-08-14", usage: "245 kWh", junk: 1 },
      sample: { role: "special_shape", tags: ["Long", "multi-column", "!!bad!!"], reason: "長尺で 2 段組" },
      content_tags: ["utility", "daily"],
    });
    expect(status).toBe(200);
    expect(json.labels).toEqual({ applied: true });
    // utility は投入先 (cost_rules → 水道光熱費ビュー) が配線されているので自動投入される
    expect(json.auto_commit).toEqual({ committed: true, already: false });

    const row = receipts.find(id)!;
    expect(row.doc_kind).toBe("utility");
    expect(JSON.parse(row.kind_fields!)).toEqual({
      supplier: "東京電力", period_from: "2026-07-15", period_to: "2026-08-14", usage: "245 kWh",
    });
    expect(row.sample_role).toBe("special_shape");
    expect(JSON.parse(row.sample_tags!)).toEqual(["long", "multi_column"]);
    expect(row.sample_reason).toBe("長尺で 2 段組");
    expect(row.sample_source).toBe("llm");
    expect(JSON.parse(row.content_tags!)).toEqual(["utility", "daily"]);
    expect(row.committed_at).not.toBeNull();
  });

  it("語彙外の kind は 400、 kind だけ (sample 無し) は種別のみ保存する", async () => {
    const id = await createReceipt();
    const bad = await patchJson(`/v1/receipts/${id}/ocr`, { ocr_status: "done", kind: "menu" });
    expect(bad.status).toBe(400);

    const ok = await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "X", total: 100, kind: "receipt", content_tags: ["food"],
    });
    expect(ok.status).toBe(200);
    const row = receipts.find(id)!;
    expect(row.doc_kind).toBe("receipt");
    expect(row.sample_role).toBeNull();
    expect(row.sample_source).toBe("llm");
    expect(JSON.parse(row.content_tags!)).toEqual(["food"]);
  });

  it("handwritten は自動投入されず needs_review、 手動投入は通る", async () => {
    const id = await createReceipt();
    const { json } = await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "手書き商店", total: 500,
      kind: "handwritten", sample: { role: "special_shape", tags: ["handwritten"], reason: "手書き" },
    });
    expect(json.auto_commit).toEqual({ committed: false, reason: "needs_review" });
    expect(receipts.find(id)!.committed_at).toBeNull();

    const res = await app.request(`/v1/receipts/${id}/commit`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(receipts.find(id)!.committed_at).not.toBeNull();
  });

  it("other だけ手動投入も 422 で弾き、 種別を直せば投入できる", async () => {
    const blocked = await createReceipt();
    await patchJson(`/v1/receipts/${blocked}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "P-other", total: 130, kind: "other",
    });
    const res422 = await app.request(`/v1/receipts/${blocked}/commit`, { method: "POST" });
    expect(res422.status).toBe(422);
    const j = await res422.json() as { error: string; kind: string; message: string };
    expect(j.error).toBe("kind_not_auto_committed");
    expect(j.kind).toBe("other");
    expect(j.message).toContain("種別を直してから");

    // 種別を receipt に直す → その場で投入できる
    const fix = await patchJson(`/v1/receipts/${blocked}/labels`, { doc_kind: "receipt" });
    expect(fix.status).toBe(200);
    const res = await app.request(`/v1/receipts/${blocked}/commit`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("PATCH /labels は manual で上書きし、 以後の LLM 再解析では上書きされない", async () => {
    const id = await createReceipt();
    await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "X", total: null,
      kind: "invoice", kind_fields: { issuer: "X", invoice_no: "A-1" },
      sample: { role: "good_sample", tags: [], reason: "ok" },
    });

    const fix = await patchJson(`/v1/receipts/${id}/labels`, {
      doc_kind: "receipt", sample_role: "special_shape", sample_tags: ["Faded", "glare"], sample_reason: "退色",
      content_tags: ["food"],
    });
    expect(fix.status).toBe(200);
    let row = receipts.find(id)!;
    expect(row.doc_kind).toBe("receipt");
    expect(row.kind_fields).toBeNull();          // 種別が変わったので旧 kind_fields は消える
    expect(row.sample_role).toBe("special_shape");
    expect(JSON.parse(row.sample_tags!)).toEqual(["faded", "glare"]);
    expect(row.sample_reason).toBe("退色");
    expect(row.sample_source).toBe("manual");
    expect(JSON.parse(row.content_tags!)).toEqual(["food"]);

    // LLM が再解析しても人の判断は残る
    const again = await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "X", total: 100,
      kind: "invoice", sample: { role: "none", tags: [], reason: "llm" },
    });
    expect(again.json.labels).toEqual({ applied: false, reason: "manual_override" });
    row = receipts.find(id)!;
    expect(row.doc_kind).toBe("receipt");
    expect(row.sample_role).toBe("special_shape");
    expect(row.sample_source).toBe("manual");
  });

  it("投入後は配送先を孤児化させる doc_kind の変更を拒否する", async () => {
    const id = await createReceipt();
    await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "X", total: 100, kind: "receipt",
    });
    expect(receipts.find(id)!.committed_at).not.toBeNull();

    const changed = await patchJson(`/v1/receipts/${id}/labels`, { doc_kind: "statement" });
    expect(changed.status).toBe(409);
    expect(changed.json).toEqual({ error: "committed_kind_immutable" });
    expect(receipts.find(id)!.doc_kind).toBe("receipt");

    const llmChanged = await patchJson(`/v1/receipts/${id}/ocr`, {
      ocr_status: "done", date: "2026-04-15", payee: "X", total: 100,
      kind: "statement", kind_fields: { rows: [{ date: "2026-04-15", description: "X", amount: 100 }] },
    });
    expect(llmChanged.status).toBe(409);
    expect(llmChanged.json).toEqual({ error: "receipt_committed" });
    expect(receipts.find(id)!.doc_kind).toBe("receipt");
  });

  it("PATCH /labels: 空 body は 400、 未知 id は 404、 語彙外は 400", async () => {
    const id = await createReceipt();
    expect((await patchJson(`/v1/receipts/${id}/labels`, {})).status).toBe(400);
    expect((await patchJson(`/v1/receipts/${id}/labels`, { sample_role: "great" })).status).toBe(400);
    expect((await patchJson(`/v1/receipts/nope/labels`, { doc_kind: "receipt" })).status).toBe(404);
  });

  it("PATCH /labels は special_shape を形状タグ無しで保存しない", async () => {
    const id = await createReceipt();
    const invalid = await patchJson(`/v1/receipts/${id}/labels`, {
      sample_role: "special_shape",
      sample_tags: [],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error).toBe("special_shape_requires_tag");
    expect(receipts.find(id)!.sample_role).toBeNull();
  });

  it("GET /v1/receipts は doc_kind / sample_role で絞れる", async () => {
    const a = await createReceipt();
    const b = await createReceipt();
    await patchJson(`/v1/receipts/${a}/ocr`, { ocr_status: "done", kind: "utility", sample: { role: "good_sample", tags: [] } });
    await patchJson(`/v1/receipts/${b}/ocr`, { ocr_status: "done", kind: "receipt", sample: { role: "none", tags: [] } });

    const utility = await (await app.request("/v1/receipts?doc_kind=utility")).json() as { total: number; items: { id: string }[] };
    expect(utility.total).toBe(1);
    expect(utility.items[0]!.id).toBe(a);
    const good = await (await app.request("/v1/receipts?sample_role=good_sample")).json() as { total: number };
    expect(good.total).toBe(1);
    expect((await app.request("/v1/receipts?doc_kind=menu")).status).toBe(400);
  });
});

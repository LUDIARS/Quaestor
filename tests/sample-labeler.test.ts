import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/db/schema.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReceiptStorage } from "../src/services/receipt-storage.js";
import { runSampleLabeling, type LabelRunner } from "../src/services/sample-labeler.js";
import { applyManualLabels } from "../src/services/receipt-labels.js";

/**
 * 既存レシートのラベル後付け (spec SPEC-SCAN-KIND-004)。 runner はモック (claude CLI を起動しない)。
 */

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

describe("sample-labeler", () => {
  let db: Database.Database;
  let receipts: ReceiptsRepo;
  let storage: ReceiptStorage;
  let root: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    receipts = new ReceiptsRepo(db);
    root = mkdtempSync(join(tmpdir(), "qlabel-"));
    storage = new ReceiptStorage(root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function seed(status: "done" | "manual" | "failed" | "pending" = "done", capturedAt = 1_000): string {
    const id = receipts.insert({ captured_at: capturedAt });
    const saved = storage.save(id, PNG_1x1, capturedAt, "png");
    receipts.setImagePath(id, saved.relativePath);
    if (status !== "pending") receipts.setOcrResult(id, { ocr_status: status, payee: "X", total: 1, date: "2026-01-01" });
    return id;
  }

  const good: LabelRunner = async () => ({
    kind: "receipt", sample: { role: "good_sample", tags: [], reason: "ok" }, content_tags: ["food"],
  });

  it("未ラベルを撮影順に 1 件ずつラベル付けし、 再実行では既ラベルをスキップする", async () => {
    const a = seed("done", 100);
    const b = seed("manual", 50);
    const prompts: string[] = [];
    const runner: LabelRunner = async (p) => { prompts.push(p); return good(p); };

    const r1 = await runSampleLabeling({ receipts, storage, runner });
    expect(r1).toMatchObject({ unlabeledBefore: 2, scanned: 2, labeled: 2, skipped: 0, failed: 0, dryRun: false });
    // 撮影順 (b が先)
    expect(r1.items.map((i) => i.id)).toEqual([b, a]);
    // prompt には画像の絶対パスが載る (claude が Read で視認する)
    expect(prompts[0]).toContain(storage.resolve(receipts.find(b)!.image_path!));
    for (const id of [a, b]) {
      const row = receipts.find(id)!;
      expect(row.sample_role).toBe("good_sample");
      expect(row.sample_source).toBe("llm");
      expect(row.doc_kind).toBe("receipt");
      expect(JSON.parse(row.content_tags!)).toEqual(["food"]);
      // fields は再抽出しない (元の値のまま)
      expect(row.payee).toBe("X");
    }

    const r2 = await runSampleLabeling({ receipts, storage, runner });
    expect(r2).toMatchObject({ unlabeledBefore: 0, scanned: 0, labeled: 0 });
    expect(prompts).toHaveLength(2);
  });

  it("--limit で件数を絞り、 残りは次回に回る (中断再開)", async () => {
    seed("done", 1); seed("done", 2); seed("done", 3);
    const r1 = await runSampleLabeling({ receipts, storage, runner: good }, { limit: 2 });
    expect(r1).toMatchObject({ unlabeledBefore: 3, scanned: 2, labeled: 2 });
    expect(receipts.countUnlabeled()).toBe(1);
    const r2 = await runSampleLabeling({ receipts, storage, runner: good }, { limit: 2 });
    expect(r2).toMatchObject({ unlabeledBefore: 1, scanned: 1, labeled: 1 });
    expect(receipts.countUnlabeled()).toBe(0);
  });

  it("--dry-run は runner を呼ばず、 何も書かない", async () => {
    seed("done");
    let calls = 0;
    const runner: LabelRunner = async () => { calls++; return good(""); };
    const r = await runSampleLabeling({ receipts, storage, runner }, { dryRun: true });
    expect(r).toMatchObject({ scanned: 1, labeled: 0, dryRun: true });
    expect(r.items[0]!.status).toBe("planned");
    expect(calls).toBe(0);
    expect(receipts.countUnlabeled()).toBe(1);
  });

  it("runner の例外 / 語彙外の応答は書かずに次へ進み、 再実行で再試行される", async () => {
    const bad = seed("done", 1);
    const invalid = seed("done", 2);
    const ok = seed("done", 3);
    const flaky: LabelRunner = async (p) => {
      if (p.includes(receipts.find(bad)!.image_path!.split("/").pop()!)) throw new Error("boom");
      if (p.includes(receipts.find(invalid)!.image_path!.split("/").pop()!)) return { kind: "menu" };
      return good(p);
    };
    const r1 = await runSampleLabeling({ receipts, storage, runner: flaky });
    expect(r1).toMatchObject({ scanned: 3, labeled: 1, failed: 2 });
    expect(r1.items.find((i) => i.id === bad)).toMatchObject({ status: "failed", error: "boom" });
    expect(r1.items.find((i) => i.id === invalid)).toMatchObject({ status: "failed", error: "invalid_labels" });
    expect(receipts.find(ok)!.sample_role).toBe("good_sample");
    expect(receipts.find(bad)!.sample_role).toBeNull();
    expect(receipts.countUnlabeled()).toBe(2);

    const r2 = await runSampleLabeling({ receipts, storage, runner: good });
    expect(r2).toMatchObject({ scanned: 2, labeled: 2, failed: 0 });
    expect(receipts.countUnlabeled()).toBe(0);
  });

  it("人手で触った receipt と OCR 未完の receipt は対象にしない", async () => {
    const manual = seed("done");
    applyManualLabels(receipts, manual, { doc_kind: "invoice" }); // sample_role は NULL のまま manual
    seed("pending");
    const r = await runSampleLabeling({ receipts, storage, runner: good });
    expect(r).toMatchObject({ unlabeledBefore: 0, scanned: 0, labeled: 0, skipped: 0 });
    expect(r.items).toEqual([]);
    expect(receipts.countUnlabeled()).toBe(0);
    expect(receipts.find(manual)!.doc_kind).toBe("invoice");
  });

  it("storage root 外を指す壊れた image_path は LLM に渡さない", async () => {
    const id = seed("done");
    db.prepare("UPDATE receipts SET image_path = '../private.txt' WHERE id = ?").run(id);
    let calls = 0;
    const runner: LabelRunner = async () => { calls++; return good(""); };

    const r = await runSampleLabeling({ receipts, storage, runner });
    expect(r).toMatchObject({ scanned: 1, labeled: 0, failed: 1 });
    expect(calls).toBe(0);
    expect(r.items[0]!.error).toContain("escapes storage root");
  });
});

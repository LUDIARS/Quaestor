import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { buildApp } from "../src/app.js";

/**
 * 1x1 px の最小 PNG (透過) を base64 で。 image_b64 入力テスト用 fixture。
 */
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

describe("API: /v1/receipts", () => {
  let app: ReturnType<typeof buildApp>;
  let receiptsRoot: string;

  beforeEach(() => {
    receiptsRoot = mkdtempSync(join(tmpdir(), "quaestor-receipts-"));
    app = buildApp({ db: new Database(":memory:"), receiptsRoot });
  });
  afterEach(() => { rmSync(receiptsRoot, { recursive: true, force: true }); });

  it("POST creates a pending receipt with image saved on disk", async () => {
    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_b64: PNG_1x1,
        ext: "png",
        captured_at: 1735689600,    // 2025-01-01 00:00:00 UTC
        geo: { lat: 35.65, lon: 139.69 },
        metadata: { source: "ar-scanner-test", bbox: { x: 100, y: 100, w: 200, h: 400 } },
      }),
    });
    expect(res.status).toBe(201);
    const j = await res.json() as { receipt: { id: string; image_path: string; ocr_status: string }; stored_size: number };
    expect(j.receipt.ocr_status).toBe("pending");
    expect(j.receipt.image_path).toMatch(/^2025\/01\/[0-9a-f-]+\.png$/);
    expect(j.stored_size).toBeGreaterThan(0);

    // 画像が disk に出来てる
    const abs = join(receiptsRoot, j.receipt.image_path);
    expect(existsSync(abs)).toBe(true);
  });

  it("GET /:id and /:id/image", async () => {
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const cj = await create.json() as { receipt: { id: string } };
    const id = cj.receipt.id;

    const get = await app.request(`/v1/receipts/${id}`);
    expect(get.status).toBe(200);

    const img = await app.request(`/v1/receipts/${id}/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await img.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it("PATCH /:id/ocr updates ocr fields and status", async () => {
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const id = ((await create.json()) as { receipt: { id: string } }).receipt.id;

    const patch = await app.request(`/v1/receipts/${id}/ocr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ocr_status: "done",
        date: "2025-04-15",
        payee: "サイゼリヤ 中目黒店",
        total: 1820,
        items: [
          { name: "ミラノ風ドリア", price: 460, qty: 1 },
          { name: "ハンバーグ", price: 600, qty: 1 },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    const j = await patch.json() as { receipt: { ocr_status: string; payee: string; total: number; items: string } };
    expect(j.receipt.ocr_status).toBe("done");
    expect(j.receipt.payee).toBe("サイゼリヤ 中目黒店");
    expect(j.receipt.total).toBe(1820);
    expect(JSON.parse(j.receipt.items)).toHaveLength(2);
  });

  it("GET / lists with status filter", async () => {
    // pending 1 件、 done 1 件作る (server-side dedup を回避するため別画像を渡す)
    // PNG_1x1 と僅かに異なる別の 1×1 PNG (1bit RGB → 黒)
    const PNG_1x1_BLACK =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
    const r1 = await (await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    })).json() as { receipt: { id: string } };
    await app.request(`/v1/receipts/${r1.receipt.id}/ocr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ocr_status: "done", payee: "test" }),
    });
    await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1_BLACK, ext: "png" }),
    });

    const all = await (await app.request("/v1/receipts")).json() as { total: number };
    expect(all.total).toBe(2);

    const pending = await (await app.request("/v1/receipts?status=pending")).json() as { total: number };
    expect(pending.total).toBe(1);

    const done = await (await app.request("/v1/receipts?status=done")).json() as { total: number };
    expect(done.total).toBe(1);
  });

  it("rejects oversized image", async () => {
    // 26MB の dummy buffer
    const big = Buffer.alloc(26 * 1024 * 1024, 0).toString("base64");
    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: big }),
    });
    expect(res.status).toBe(413);
  });

  it("DELETE removes db row", async () => {
    const create = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: PNG_1x1, ext: "png" }),
    });
    const id = ((await create.json()) as { receipt: { id: string } }).receipt.id;
    const del = await app.request(`/v1/receipts/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const get = await app.request(`/v1/receipts/${id}`);
    expect(get.status).toBe(404);
  });
});

describe("API: /v1/receipts/:id/commit — 投入 (date-place-amount unique)", () => {
  let app: ReturnType<typeof buildApp>;
  let receiptsRoot: string;

  // 別画像 (image-hash dedup を避ける)
  const PNG_BLACK =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";

  beforeEach(() => {
    receiptsRoot = mkdtempSync(join(tmpdir(), "quaestor-commit-"));
    app = buildApp({ db: new Database(":memory:"), receiptsRoot });
  });
  afterEach(() => { rmSync(receiptsRoot, { recursive: true, force: true }); });

  async function createReceipt(b64: string): Promise<string> {
    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: b64, ext: "png" }),
    });
    return ((await res.json()) as { receipt: { id: string } }).receipt.id;
  }

  async function setOcr(id: string, fields: Record<string, unknown>): Promise<void> {
    await app.request(`/v1/receipts/${id}/ocr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ocr_status: "done", ...fields }),
    });
  }

  it("rejects commit when date/payee/total incomplete (422)", async () => {
    const id = await createReceipt(PNG_1x1);
    await setOcr(id, { payee: "サイゼリヤ", total: 1820 }); // date 欠落
    const res = await app.request(`/v1/receipts/${id}/commit`, { method: "POST" });
    expect(res.status).toBe(422);
    const j = await res.json() as { error: string; missing: string[] };
    expect(j.error).toBe("incomplete");
    expect(j.missing).toContain("date");
  });

  it("commits when complete and sets committed_at", async () => {
    const id = await createReceipt(PNG_1x1);
    await setOcr(id, { date: "2025-04-15", payee: "サイゼリヤ 中目黒店", total: 1820 });
    const res = await app.request(`/v1/receipts/${id}/commit`, { method: "POST" });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; receipt: { committed_at: number | null } };
    expect(j.ok).toBe(true);
    expect(j.receipt.committed_at).toBeGreaterThan(0);
  });

  it("rejects duplicate by (date-place-amount) with 409", async () => {
    const a = await createReceipt(PNG_1x1);
    await setOcr(a, { date: "2025-04-15", payee: "サイゼリヤ 中目黒店", total: 1820 });
    expect((await app.request(`/v1/receipts/${a}/commit`, { method: "POST" })).status).toBe(200);

    const b = await createReceipt(PNG_BLACK);
    await setOcr(b, { date: "2025-04-15", payee: "サイゼリヤ 中目黒店", total: 1820 });
    const res = await app.request(`/v1/receipts/${b}/commit`, { method: "POST" });
    expect(res.status).toBe(409);
    const j = await res.json() as { error: string; existing_id: string };
    expect(j.error).toBe("duplicate");
    expect(j.existing_id).toBe(a);
  });

  it("payee 正規化で重複判定 (全角/空白/大小)", async () => {
    const a = await createReceipt(PNG_1x1);
    await setOcr(a, { date: "2025-05-01", payee: "ABC Store", total: 500 });
    expect((await app.request(`/v1/receipts/${a}/commit`, { method: "POST" })).status).toBe(200);

    const b = await createReceipt(PNG_BLACK);
    // 全角英字 + 余分な空白 → 正規化すると "ABC STORE" で一致
    await setOcr(b, { date: "2025-05-01", payee: "ＡＢＣ　　Store", total: 500 });
    const res = await app.request(`/v1/receipts/${b}/commit`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("commit は冪等 (再投入は already:true)", async () => {
    const id = await createReceipt(PNG_1x1);
    await setOcr(id, { date: "2025-06-01", payee: "X", total: 100 });
    expect((await app.request(`/v1/receipts/${id}/commit`, { method: "POST" })).status).toBe(200);
    const res2 = await app.request(`/v1/receipts/${id}/commit`, { method: "POST" });
    expect(res2.status).toBe(200);
    const j = await res2.json() as { ok: boolean; already: boolean };
    expect(j.already).toBe(true);
  });
});

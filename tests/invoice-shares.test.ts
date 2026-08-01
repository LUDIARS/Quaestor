import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/db/schema.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import { InvoiceShareRepo } from "../src/db/invoice-share-repo.js";
import { InvoiceShareError, InvoiceShareService } from "../src/services/invoice-share-service.js";
import { InvoiceShareRateLimiter } from "../src/services/invoice-share-rate-limiter.js";
import { buildApp } from "../src/app.js";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n", "ascii");
const CLIENT = "教育機関 <A&B>";
const START = 1_760_000_000;

/** PDF を置く一時 root。 macOS の tmpdir は symlink なので realpath 済を使う。 */
function makeRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function createdInvoice(invoices: InvoicesRepo): number {
  return invoices.insert({
    issued_at: "2026-04-15",
    due_date: "2026-05-15",
    client: CLIENT,
    work_summary: "4 月分授業料",
    amount: 100000,
  });
}

describe("InvoiceShareService", () => {
  let db: Database.Database;
  let invoices: InvoicesRepo;
  let shares: InvoiceShareRepo;
  let root: string;
  let outsideRoot: string;
  let pdfPath: string;
  let invoiceId: number;
  let clock: number;
  let tokenSeq: number;
  let service: InvoiceShareService;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    invoices = new InvoicesRepo(db);
    shares = new InvoiceShareRepo(db);
    root = makeRoot("quaestor-share-root-");
    outsideRoot = makeRoot("quaestor-share-out-");
    pdfPath = join(root, "invoice.pdf");
    writeFileSync(pdfPath, PDF);
    invoiceId = createdInvoice(invoices);
    clock = START;
    tokenSeq = 0;
    service = new InvoiceShareService({
      invoices,
      shares,
      publicBaseUrl: "https://qs.example.com",
      allowedRoots: [root],
      now: () => clock,
      tokenFactory: () => `tok${String(tokenSeq++).padStart(2, "0")}`.padEnd(43, "x"),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  function token(url: string): string {
    return url.slice(url.lastIndexOf("/") + 1);
  }

  it("create: URL は一度だけ返し、 DB には SHA-256 ダイジェストだけを保存する", async () => {
    const created = await service.create({ invoiceId, documentPath: pdfPath, expiresInDays: 14 });

    expect(created.url.startsWith("https://qs.example.com/v1/invoices/share/")).toBe(true);
    expect(created.expiresAt).toBe(START + 14 * 24 * 60 * 60);
    expect(created.filename).toBe("invoice.pdf");
    expect(created.documentSize).toBe(PDF.length);
    expect(created.documentSha256).toMatch(/^[0-9a-f]{64}$/);

    const row = shares.findById(created.id)!;
    expect(row.token_hash).not.toBe(token(created.url));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.view_count).toBe(0);
    expect(row.revoked_at).toBeNull();
  });

  it("findPublic / loadDocument: 有効なトークンで PDF を配信し view を記録する", async () => {
    const created = await service.create({ invoiceId, documentPath: pdfPath });
    expect(created.expiresAt).toBe(START + 14 * 24 * 60 * 60); // 既定 14 日

    const page = await service.findPublic(token(created.url));
    expect(page.invoice.client).toBe(CLIENT);
    expect(shares.findById(created.id)!.view_count).toBe(1);
    expect(shares.findById(created.id)!.first_viewed_at).toBe(START);

    const doc = await service.loadDocument(token(created.url));
    expect(Buffer.compare(doc.contents, PDF)).toBe(0);
    expect(doc.share.filename).toBe("invoice.pdf");
    // 閲覧しても消費されない (メールスキャナの先読み対策) 。
    expect(shares.findById(created.id)!.view_count).toBe(2);
    await expect(service.findPublic(token(created.url))).resolves.toBeDefined();
  });

  it("期限切れ・失効・不正形式のトークンは同じ not_found になる", async () => {
    const expiring = await service.create({ invoiceId, documentPath: pdfPath, expiresInDays: 1 });
    const revoked = await service.create({ invoiceId, documentPath: pdfPath, expiresInDays: 30 });

    await expect(service.findPublic("short")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(service.findPublic("!".repeat(43))).rejects.toMatchObject({ code: "not_found" });
    await expect(service.findPublic("z".repeat(43))).rejects.toMatchObject({ code: "not_found" });

    expect(service.revoke(invoiceId, revoked.id)).toBe(true);
    await expect(service.findPublic(token(revoked.url))).rejects.toMatchObject({ code: "not_found" });
    await expect(service.loadDocument(token(revoked.url))).rejects.toMatchObject({ code: "not_found" });
    // 別の invoice からは失効させられない。
    expect(service.revoke(invoiceId + 999, expiring.id)).toBe(false);

    clock = START + 24 * 60 * 60 + 1;
    await expect(service.findPublic(token(expiring.url))).rejects.toMatchObject({ code: "not_found" });
  });

  it("cancelled の invoice は公開されない", async () => {
    const created = await service.create({ invoiceId, documentPath: pdfPath });
    invoices.update(invoiceId, { status: "cancelled" });
    await expect(service.findPublic(token(created.url))).rejects.toMatchObject({ code: "not_found" });
    await expect(service.create({ invoiceId, documentPath: pdfPath }))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("発行後に PDF が差し替わったら fail-closed で 409 になる", async () => {
    const created = await service.create({ invoiceId, documentPath: pdfPath });

    // 同じバイト数のまま中身だけ差し替える (size 検査ではなく hash 検査を通す) 。
    const tampered = Buffer.from(PDF);
    tampered[tampered.length - 2] = 0x58;
    writeFileSync(pdfPath, tampered);

    await expect(service.loadDocument(token(created.url)))
      .rejects.toMatchObject({ code: "document_changed", status: 409 });

    // 長さが変わる差し替えも同じく 409。
    writeFileSync(pdfPath, Buffer.concat([PDF, Buffer.from("extra")]));
    await expect(service.loadDocument(token(created.url)))
      .rejects.toMatchObject({ code: "document_changed", status: 409 });
  });

  it("許可 root 外・非 PDF・PDF 署名なしのドキュメントを拒否する", async () => {
    const outside = join(outsideRoot, "invoice.pdf");
    writeFileSync(outside, PDF);
    const notPdf = join(root, "invoice.txt");
    writeFileSync(notPdf, PDF);
    const fakePdf = join(root, "fake.pdf");
    writeFileSync(fakePdf, Buffer.from("NOT A PDF AT ALL", "ascii"));

    for (const path of [outside, notPdf, fakePdf, join(root, "missing.pdf"), join(root, "..", "invoice.pdf")]) {
      await expect(service.create({ invoiceId, documentPath: path }))
        .rejects.toMatchObject({ code: "document_invalid" });
    }
  });

  it("expiresInDays の範囲外は invalid_request", async () => {
    for (const days of [0, 31, 1.5]) {
      await expect(service.create({ invoiceId, documentPath: pdfPath, expiresInDays: days }))
        .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    }
  });

  it("QUAESTOR_PUBLIC_URL が未設定/非 HTTPS/パス付きなら loopback にせず 503 で落ちる", async () => {
    for (const publicBaseUrl of [
      undefined,
      "   ",
      "http://qs.example.com",
      "https://qs.example.com/invoices",
      "https://user:pw@qs.example.com",
      "https://qs.example.com/?a=1",
      "not-a-url",
    ]) {
      const misconfigured = new InvoiceShareService({
        invoices,
        shares,
        publicBaseUrl,
        allowedRoots: [root],
        now: () => clock,
      });
      await expect(misconfigured.create({ invoiceId, documentPath: pdfPath }))
        .rejects.toMatchObject({ code: "not_configured", status: 503 });
    }

    // 末尾スラッシュは正規化して受け入れる。
    const ok = new InvoiceShareService({
      invoices, shares, publicBaseUrl: "https://qs.example.com/", allowedRoots: [root], now: () => clock,
    });
    const created = await ok.create({ invoiceId, documentPath: pdfPath });
    expect(created.url.startsWith("https://qs.example.com/v1/invoices/share/")).toBe(true);
  });

  it("InvoiceShareError は公開向けに内部パスを漏らさない", async () => {
    const error = await service.create({ invoiceId, documentPath: join(outsideRoot, "x.pdf") })
      .catch((e: unknown) => e as InvoiceShareError);
    expect(error).toBeInstanceOf(InvoiceShareError);
    expect((error as InvoiceShareError).message).not.toContain(outsideRoot);
  });
});

describe("invoice share schema migration", () => {
  /** 正式導入前のローカル版が作っていた非互換テーブル (index 名は現行と衝突する)。 */
  function createLegacyShareTable(db: Database.Database, table: string): void {
    db.exec(`CREATE TABLE ${table} (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      recipient_email TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      viewed_at INTEGER
    )`);
    db.prepare(`INSERT INTO ${table}
      (invoice_id, token_hash, recipient_email, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`
    ).run(42, "legacy-token-hash", "legacy@example.com", START + 100, START);
  }

  /** index はテーブルに紐づくので、 どのテーブルの index かで名前解放を確認する。 */
  function indexOwner(db: Database.Database, index: string): string | undefined {
    const row = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index) as { tbl_name: string } | undefined;
    return row?.tbl_name;
  }

  it("非互換なローカル版テーブルを行ごと保存して現行テーブルを作る", () => {
    const db = new Database(":memory:");
    try {
      createLegacyShareTable(db, "invoice_share_tokens");
      // ローカル版が現行と同名の index を持っていても、 現行テーブル側に張り直せること。
      db.exec("CREATE INDEX idx_invoice_share_invoice ON invoice_share_tokens(invoice_id, created_at)");
      db.exec("CREATE INDEX idx_invoice_share_expiry ON invoice_share_tokens(expires_at)");

      applyMigrations(db);

      const currentColumns = db.pragma("table_info(invoice_share_tokens)") as { name: string }[];
      expect(currentColumns.map(({ name }) => name)).toContain("document_sha256");
      expect(currentColumns.map(({ name }) => name)).toContain("revoked_at");
      expect(db.prepare("SELECT COUNT(*) AS count FROM invoice_share_tokens").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT recipient_email FROM invoice_share_tokens_legacy_v8").get())
        .toEqual({ recipient_email: "legacy@example.com" });
      expect(indexOwner(db, "idx_invoice_share_invoice")).toBe("invoice_share_tokens");
      expect(indexOwner(db, "idx_invoice_share_expiry")).toBe("invoice_share_tokens");

      // 冪等: 2回目は現行テーブルを維持する。
      expect(() => applyMigrations(db)).not.toThrow();
      expect(db.prepare("SELECT recipient_email FROM invoice_share_tokens_legacy_v8").get())
        .toEqual({ recipient_email: "legacy@example.com" });
    } finally {
      db.close();
    }
  });

  it("退避先が既に埋まっている場合は上書きせず失敗し、 元テーブルを残す", () => {
    const db = new Database(":memory:");
    try {
      createLegacyShareTable(db, "invoice_share_tokens");
      createLegacyShareTable(db, "invoice_share_tokens_legacy_v8");

      expect(() => applyMigrations(db)).toThrow(/legacy/);

      // transaction が rollback されるので、 退避前の行はどちらのテーブルにも残る。
      expect(db.prepare("SELECT COUNT(*) AS count FROM invoice_share_tokens").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM invoice_share_tokens_legacy_v8").get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});

describe("InvoiceShareRateLimiter", () => {
  it("固定ウィンドウで上限を超えた分だけ拒否し、 ウィンドウ経過後に復帰する", () => {
    let now = 0;
    const limiter = new InvoiceShareRateLimiter(3, 60_000, () => now);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);

    const blocked = limiter.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);

    // キーが違えば独立している。
    expect(limiter.check("b").allowed).toBe(true);

    now = 60_000;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("不正な設定値を拒否する", () => {
    expect(() => new InvoiceShareRateLimiter(0)).toThrow();
    expect(() => new InvoiceShareRateLimiter(60, 0)).toThrow();
  });
});

describe("API: /v1/invoices share links", () => {
  let db: Database.Database;
  let root: string;
  let pdfPath: string;
  let app: ReturnType<typeof buildApp>;
  let invoiceId: number;

  beforeEach(() => {
    root = makeRoot("quaestor-share-api-");
    pdfPath = join(root, "請求書.pdf");
    writeFileSync(pdfPath, PDF);
    db = new Database(":memory:");
    app = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: "https://qs.example.com", roots: [root] },
    });
    invoiceId = createdInvoice(new InvoicesRepo(db));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createShare(body: Record<string, unknown> = { document_path: pdfPath }) {
    return app.request(`/v1/invoices/${invoiceId}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("発行 → ランディング → PDF 配信 → 失効 の一連が動く", async () => {
    const create = await createShare({ document_path: pdfPath, expires_in_days: 7 });
    expect(create.status).toBe(201);
    const created = await create.json() as { share_id: string; share_url: string; filename: string };
    const token = created.share_url.slice(created.share_url.lastIndexOf("/") + 1);
    expect(created.filename).toBe("請求書.pdf");

    const page = await app.request(`/v1/invoices/share/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    const html = await page.text();
    // invoice の値は HTML エスケープされ、 保存パスやトークンハッシュは出さない。
    expect(html).toContain("教育機関 &lt;A&amp;B&gt;");
    expect(html).not.toContain("<A&B>");
    expect(html).not.toContain(root);

    const pdf = await app.request(`/v1/invoices/share/${token}/document.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(Buffer.from(await pdf.arrayBuffer()).equals(PDF)).toBe(true);

    const revoke = await app.request(
      `/v1/invoices/${invoiceId}/share-links/${created.share_id}/revoke`,
      { method: "POST" },
    );
    expect(revoke.status).toBe(200);

    const afterRevoke = await app.request(`/v1/invoices/share/${token}`);
    expect(afterRevoke.status).toBe(404);
    expect(await afterRevoke.text()).toContain("リンクを確認できません");
    expect((await app.request(`/v1/invoices/share/${token}/document.pdf`)).status).toBe(404);
  });

  it("publicUrl 未設定なら発行を 503 で断り、 loopback URL を返さない", async () => {
    const bare = new Database(":memory:");
    try {
      const unconfigured = buildApp({ db: bare, receiptsRoot: join(root, "receipts"), ocr: "disabled" });
      const id = createdInvoice(new InvoicesRepo(bare));
      const res = await unconfigured.request(`/v1/invoices/${id}/share-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document_path: pdfPath }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "not_configured" });
    } finally {
      bare.close();
    }
  });

  it("未知トークンは invoice の存在を漏らさず同じエラーページを返す", async () => {
    const res = await app.request(`/v1/invoices/share/${"z".repeat(43)}`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("リンクを確認できません");
    expect(body).not.toContain("教育機関");
  });

  it("share 用のルートが既存 invoice CRUD を壊さない", async () => {
    const get = await app.request(`/v1/invoices/${invoiceId}`);
    expect(get.status).toBe(200);
    expect((await app.request("/v1/invoices/summary")).status).toBe(200);
  });

  it("不正な body / invoice id を 400 で弾く", async () => {
    expect((await createShare({})).status).toBe(400);
    expect((await createShare({ document_path: pdfPath, expires_in_days: 99 })).status).toBe(400);
    expect((await createShare({ document_path: pdfPath, unexpected: 1 })).status).toBe(400);
    const badId = await app.request("/v1/invoices/abc/share-links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath }),
    });
    expect(badId.status).toBe(400);
  });

  it("上限超過は 429 + Retry-After を返す", async () => {
    const headers = { "CF-Connecting-IP": "203.0.113.9" };
    let last = new Response(null, { status: 200 });
    for (let i = 0; i < 61; i += 1) {
      last = await app.request(`/v1/invoices/share/${"z".repeat(43)}`, { headers });
    }
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(last.headers.get("cache-control")).toBe("no-store");

    // 別 IP は影響を受けない。
    const other = await app.request(`/v1/invoices/share/${"z".repeat(43)}`, {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    });
    expect(other.status).toBe(404);
  });
});

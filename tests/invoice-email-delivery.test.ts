import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { InvoiceDeliveryContactsRepo } from "../src/db/invoice-delivery-contacts-repo.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import type { InvoiceEmailMessage, InvoiceEmailNotifier } from "../src/services/invoice-email-notifier.js";

const PDF = Buffer.from("%PDF-1.7\ntrailer\n%%EOF\n", "ascii");

describe("invoice email delivery", () => {
  let db: Database.Database;
  let root: string;
  let pdfPath: string;
  let invoiceId: number;
  let recipientId: string;
  let sent: InvoiceEmailMessage[];
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "quaestor-email-delivery-")));
    pdfPath = join(root, "invoice.pdf");
    writeFileSync(pdfPath, PDF);
    db = new Database(":memory:");
    sent = [];
    const notifier: InvoiceEmailNotifier = {
      assertReady: () => undefined,
      sendMessage: async (message) => {
        sent.push(message);
        return { messageId: `ses-${sent.length}` };
      },
    };
    app = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: "https://qs.example.com", roots: [root] },
      invoiceEmailNotifier: notifier,
    });
    invoiceId = new InvoicesRepo(db).insert({
      issued_at: "2026-08-02",
      due_date: "2026-08-31",
      client: "Example Customer",
      work_summary: "2026年7月分",
      amount: 123456,
    });
    // 実在の顧客名・実在アドレス・実請求額はテスト固定値にしない。
    recipientId = new InvoiceDeliveryContactsRepo(db).insert({
      companyName: "Example Customer",
      email: "billing@example.com",
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("URLをレスポンスへ返さず、登録先へだけ送り、同一キーの再試行を重複送信しない", async () => {
    const idempotencyKey = "6e9fc268-dbe2-43d2-922c-e667a781220f";
    const body = {
      document_path: pdfPath,
      recipient_id: recipientId,
      idempotency_key: idempotencyKey,
      billing_period: "2026年7月分",
    };
    const deliver = () => app.request(`/v1/invoices/${invoiceId}/share-links/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const first = await deliver();
    expect(first.status).toBe(201);
    const result = await first.json() as Record<string, unknown>;
    expect(result).not.toHaveProperty("share_url");
    expect(result).not.toHaveProperty("token");
    expect(result).toMatchObject({ delivery_status: "sent", recipient_email: "billing@example.com" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("billing@example.com");
    expect(sent[0]?.text).toContain("https://qs.example.com/v1/invoices/share/");
    expect(sent[0]?.text).not.toContain("123456");

    const retry = await deliver();
    expect(retry.status).toBe(201);
    expect(sent).toHaveLength(1);
  });

  it("通常構成では生URL発行APIを公開しない", async () => {
    const response = await app.request(`/v1/invoices/${invoiceId}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath, recipient_id: recipientId }),
    });
    expect(response.status).toBe(404);
  });

  // notifier 未注入の buildApp が実 SES クライアントへ落ちると、テストが開発機の
  // 資格情報で fixture 宛に実メールを送りうる。 未注入は送信到達前に 503 で閉じる。
  it("notifier 未注入なら実SESへ fallback せず 503 not_configured を返す", async () => {
    const uninjected = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: "https://qs.example.com", roots: [root] },
    });
    const response = await uninjected.request(`/v1/invoices/${invoiceId}/share-links/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document_path: pdfPath,
        recipient_id: recipientId,
        idempotency_key: "0e1f5f27-4b1a-4a17-9f0d-2a6f9f2b5c31",
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "not_configured" });
    expect(sent).toHaveLength(0);
  });
});

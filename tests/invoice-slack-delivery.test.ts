import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applyMigrations } from "../src/db/schema.js";
import { InvoiceShareRepo } from "../src/db/invoice-share-repo.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import { InvoiceShareService } from "../src/services/invoice-share-service.js";
import { InvoiceSlackDeliveryService } from "../src/services/invoice-slack-delivery.js";
import {
  SlackDeliveryError,
  SlackWebApiClient,
  resolveSlackInvoiceTarget,
  type SlackInvoiceMessage,
  type SlackInvoiceNotifier,
} from "../src/services/slack-web-api-client.js";

const PDF = Buffer.from("%PDF-1.7\ntrailer\n%%EOF\n", "ascii");
const TOKEN = "slack-test-token".padEnd(43, "x");

class FakeNotifier implements SlackInvoiceNotifier {
  readonly messages: SlackInvoiceMessage[] = [];
  constructor(private readonly failure?: Error) {}

  assertReady(): void {}

  async postMessage(message: SlackInvoiceMessage) {
    this.messages.push(message);
    if (this.failure) throw this.failure;
    return { conversationId: "G123ABC", messageTs: "1710000000.123456" };
  }
}

describe("SlackWebApiClient", () => {
  it("既存グループ DM へリンクを投稿する", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = new SlackWebApiClient({
      botToken: "xoxb-test",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({ ok: true, channel: "G123ABC", ts: "1710000000.123456" });
      },
    });

    const result = await client.postMessage({
      target: { conversationId: "G123ABC" },
      text: "請求書リンク",
      blocks: [],
    });

    expect(result).toEqual({ conversationId: "G123ABC", messageTs: "1710000000.123456" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.body).toMatchObject({
      channel: "G123ABC",
      text: "請求書リンク",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("2〜8名の user ID からグループ DM を開いて投稿する", async () => {
    const methods: string[] = [];
    const client = new SlackWebApiClient({
      botToken: "xoxb-test",
      fetchImpl: async (input) => {
        const method = String(input).split("/").at(-1)!;
        methods.push(method);
        return method === "conversations.open"
          ? Response.json({ ok: true, channel: { id: "G456DEF" } })
          : Response.json({ ok: true, channel: "G456DEF", ts: "1710000001.000001" });
      },
    });

    const result = await client.postMessage({
      target: { userIds: ["U123ABC", "W456DEF"] },
      text: "請求書リンク",
      blocks: [],
    });

    expect(methods).toEqual(["conversations.open", "chat.postMessage"]);
    expect(result.conversationId).toBe("G456DEF");
  });

  it("未設定・不正対象・Slack API エラーを安全な分類で返す", async () => {
    const noToken = new SlackWebApiClient();
    expect(() => noToken.assertReady({ conversationId: "G123ABC" }))
      .toThrow(expect.objectContaining({ code: "not_configured", status: 503 }));

    const client = new SlackWebApiClient({
      botToken: "xoxb-test",
      fetchImpl: async () => Response.json({ ok: false, error: "channel_not_found" }),
    });
    expect(() => client.assertReady({ userIds: ["U123ABC"] }))
      .toThrow(expect.objectContaining({ code: "invalid_target", status: 400 }));
    await expect(client.postMessage({
      target: { conversationId: "G123ABC" }, text: "x", blocks: [],
    })).rejects.toMatchObject({ code: "api_error", status: 502 });
  });

  it("環境変数は conversation ID と user IDs の同時指定を拒否する", () => {
    expect(resolveSlackInvoiceTarget({ QUAESTOR_SLACK_CONVERSATION_ID: "G123ABC" }))
      .toEqual({ conversationId: "G123ABC" });
    expect(resolveSlackInvoiceTarget({ QUAESTOR_SLACK_USER_IDS: "U123ABC; W456DEF" }))
      .toEqual({ userIds: ["U123ABC", "W456DEF"] });
    expect(() => resolveSlackInvoiceTarget({
      QUAESTOR_SLACK_CONVERSATION_ID: "G123ABC",
      QUAESTOR_SLACK_USER_IDS: "U123ABC;W456DEF",
    })).toThrow(expect.objectContaining({ code: "invalid_target" }));
  });
});

describe("InvoiceSlackDeliveryService", () => {
  let db: Database.Database;
  let root: string;
  let pdfPath: string;
  let invoices: InvoicesRepo;
  let shares: InvoiceShareRepo;
  let shareService: InvoiceShareService;
  let invoiceId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    root = realpathSync(mkdtempSync(join(tmpdir(), "quaestor-slack-")));
    pdfPath = join(root, "請求書.pdf");
    writeFileSync(pdfPath, PDF);
    invoices = new InvoicesRepo(db);
    shares = new InvoiceShareRepo(db);
    invoiceId = invoices.insert({
      issued_at: "2026-07-31",
      due_date: "2026-08-31",
      client: "Example Customer",
      work_summary: "2026年7月分",
      amount: 10000,
    });
    shareService = new InvoiceShareService({
      invoices,
      shares,
      publicBaseUrl: "https://qs-magiclink.example.com",
      allowedRoots: [root],
      now: () => 1_775_000_000,
      tokenFactory: () => TOKEN,
      idFactory: () => "share-id",
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("日本語メッセージとボタンを投稿し、投稿識別子を返す", async () => {
    const notifier = new FakeNotifier();
    const service = new InvoiceSlackDeliveryService({
      invoices, shares: shareService, notifier, defaultTarget: { conversationId: "G123ABC" },
    });

    const result = await service.deliver({
      invoiceId,
      documentPath: pdfPath,
      recipientName: "Example Customer ご担当者様",
    });

    expect(result).toMatchObject({ id: "share-id", conversationId: "G123ABC" });
    expect(notifier.messages[0]?.text).toContain("Example Customer ご担当者様");
    expect(notifier.messages[0]?.text).toContain("https://qs-magiclink.example.com/v1/invoices/share/");
    expect(JSON.stringify(notifier.messages[0]?.blocks)).toContain("請求書を確認する");
  });

  it("宛名・件名の mrkdwn を fallback text と blocks の両方で escape する", async () => {
    const notifier = new FakeNotifier();
    const service = new InvoiceSlackDeliveryService({
      invoices, shares: shareService, notifier, defaultTarget: { conversationId: "G123ABC" },
    });

    await service.deliver({
      invoiceId,
      documentPath: pdfPath,
      recipientName: "<https://evil.example.com|請求書はこちら>",
      billingPeriod: "A & B",
    });

    const message = notifier.messages[0]!;
    expect(message.text).not.toContain("<https://evil.example.com|");
    expect(message.text).toContain("&lt;https://evil.example.com|請求書はこちら&gt;");
    expect(message.text).toContain("A &amp; B");
    expect(JSON.stringify(message.blocks)).not.toContain("<https://evil.example.com|");
    // 正規のリンクは escape 対象文字を含まないので button の URL は素通しで残る。
    expect(JSON.stringify(message.blocks)).toContain("https://qs-magiclink.example.com/v1/invoices/share/");
  });

  it("Slack 投稿失敗時は作成したリンクを失効する", async () => {
    const notifier = new FakeNotifier(new SlackDeliveryError("api_error", "Slack failed", 502));
    const service = new InvoiceSlackDeliveryService({
      invoices, shares: shareService, notifier, defaultTarget: { conversationId: "G123ABC" },
    });

    await expect(service.deliver({ invoiceId, documentPath: pdfPath }))
      .rejects.toMatchObject({ code: "api_error" });
    expect(shares.findById("share-id")?.revoked_at).not.toBeNull();
    await expect(shareService.findPublic(TOKEN)).rejects.toMatchObject({ code: "not_found" });
  });

  it("Slack 未設定はリンク作成前に 503 で失敗する", async () => {
    const service = new InvoiceSlackDeliveryService({
      invoices, shares: shareService, defaultTarget: { conversationId: "G123ABC" },
    });
    await expect(service.deliver({ invoiceId, documentPath: pdfPath }))
      .rejects.toMatchObject({ code: "not_configured", status: 503 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM invoice_share_tokens").get()).toEqual({ count: 0 });
  });

  it("API は既定ターゲットへ投稿し、宛先の同時指定を拒否する", async () => {
    const notifier = new FakeNotifier();
    const app = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: "https://qs-magiclink.example.com", roots: [root] },
      slackInvoiceNotifier: notifier,
      slackInvoiceTarget: { conversationId: "G123ABC" },
    });
    const response = await app.request(`/v1/invoices/${invoiceId}/share-links/slack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath, expires_in_days: 7 }),
    });
    expect(response.status).toBe(201);
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({
      slack_conversation_id: "G123ABC",
      slack_message_ts: "1710000000.123456",
    });
    expect(result).not.toHaveProperty("share_url");

    const invalid = await app.request(`/v1/invoices/${invoiceId}/share-links/slack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document_path: pdfPath,
        conversation_id: "G123ABC",
        user_ids: ["U123ABC", "U456DEF"],
      }),
    });
    expect(invalid.status).toBe(400);
  });
});

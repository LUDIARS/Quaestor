import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailMessage, MailSource } from "@ludiars/mail-inbox";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboundDocumentsRepo } from "../src/db/inbound-documents-repo.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";
import { applyMigrations } from "../src/db/schema.js";
import type { PdfExtraction } from "../src/mail/pdf-extract.js";
import { MailIntakeService } from "../src/services/mail-intake-service.js";
import type { NotificationService } from "../src/services/notification-service.js";
import { ReceiptIntake } from "../src/services/receipt-intake.js";

const REVIEW_EXTRACTION: PdfExtraction = {
  issuer: "Example",
  date: null,
  total: 1200,
  due_date: null,
  invoice_no: null,
  confidence: "low",
};

const COMPLETE_EXTRACTION: PdfExtraction = {
  issuer: "Example",
  date: "2026-09-01",
  total: 1200,
  due_date: "2026-09-30",
  invoice_no: "INV-1",
  confidence: "high",
};

describe("MailIntakeService", () => {
  let db: Database.Database;
  let documentsRoot: string;
  let messages: MailMessagesRepo;
  let documents: InboundDocumentsRepo;
  let receipts: ReceiptsRepo;
  let source: MailSource;
  let notifyMailInvoice: ReturnType<typeof vi.fn>;
  let notifyMailCloudNotice: ReturnType<typeof vi.fn>;
  let notifications: NotificationService;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    documentsRoot = mkdtempSync(join(tmpdir(), "quaestor-mail-intake-"));
    messages = new MailMessagesRepo(db);
    documents = new InboundDocumentsRepo(db);
    receipts = new ReceiptsRepo(db);
    source = mailSource([invoiceMessage()]);
    notifyMailInvoice = vi.fn(async () => ({ sent: true }));
    notifyMailCloudNotice = vi.fn(async () => ({ sent: true }));
    notifications = {
      notifyMailInvoice,
      notifyMailCloudNotice,
    } as unknown as NotificationService;
  });

  afterEach(() => {
    db.close();
    rmSync(documentsRoot, { recursive: true, force: true });
  });

  it("returns disabled without credentials", async () => {
    const service = createService(REVIEW_EXTRACTION, false);
    expect(await service.sweep()).toMatchObject({
      disabled: true,
      reason: "QUAESTOR_GMAIL_* is not configured",
    });
  });

  it("stores a reviewable PDF after claiming its parent message and processes it only once", async () => {
    const service = createService(REVIEW_EXTRACTION);

    const [first, concurrent] = await Promise.all([service.sweep(), service.sweep()]);

    expect(first.processed.invoice + concurrent.processed.invoice).toBe(1);
    expect(first.needs_review + concurrent.needs_review).toBe(1);
    expect(messages.list()).toHaveLength(1);
    const [document] = documents.list();
    expect(document).toMatchObject({ message_id: "message-1", status: "needs_review" });
    expect(existsSync(join(documentsRoot, document!.file_path))).toBe(true);
    expect(notifyMailInvoice).toHaveBeenCalledTimes(1);
    expect(source.search).toHaveBeenCalledWith("in:inbox", {
      loadAttachments: false,
      maxAttachmentBytes: 1024,
    });
    expect(source.loadAttachment).toHaveBeenCalledWith("message-1", "attachment-1");
    expect(JSON.stringify(messages.find("message-1"))).not.toContain("private body");
    expect(JSON.stringify(messages.find("message-1"))).not.toContain("private.example");
    expect(JSON.stringify(notifyMailInvoice.mock.calls)).not.toContain("private body");
    expect(JSON.stringify(notifyMailInvoice.mock.calls)).not.toContain("private snippet");

    expect((await service.sweep()).processed.invoice).toBe(0);
    expect(documents.list()).toHaveLength(1);
    expect(notifyMailInvoice).toHaveBeenCalledTimes(1);
  });

  it("creates and commits a receipt for a complete extraction", async () => {
    const result = await createService(COMPLETE_EXTRACTION).sweep();

    expect(result.committed).toBe(1);
    const [document] = documents.list();
    expect(document?.status).toBe("committed");
    expect(document?.receipt_id).toBeTruthy();
    expect(receipts.find(document!.receipt_id!)).toMatchObject({
      ocr_status: "manual",
      payee: "Example",
      date: "2026-09-01",
      total: 1200,
    });
  });

  it("keeps dry-run free of persistence, files, receipts, and notifications", async () => {
    const result = await createService(COMPLETE_EXTRACTION).sweep({ dry_run: true });

    expect(result.committed).toBe(1);
    expect(messages.list()).toEqual([]);
    expect(documents.list()).toEqual([]);
    expect(receipts.list()).toEqual([]);
    expect(notifyMailInvoice).not.toHaveBeenCalled();
  });

  it("notifies a cloud notice exactly once", async () => {
    source = mailSource([cloudMessage()]);
    const service = createService(REVIEW_EXTRACTION);

    expect((await service.sweep()).processed.cloud_notice).toBe(1);
    expect(notifyMailCloudNotice).toHaveBeenCalledTimes(1);
    expect(messages.find("cloud-1")?.outcome).toBe("notified");

    await service.sweep();
    expect(notifyMailCloudNotice).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a disabled webhook from a successful notification", async () => {
    notifyMailInvoice.mockResolvedValue({ sent: false, disabled: true });

    const result = await createService(REVIEW_EXTRACTION).sweep();

    expect(result.notifications).toBe("disabled");
    expect(messages.find("message-1")?.outcome).toBe("needs_review; notification_disabled");
  });

  it("stores only a bounded error kind rather than exception details", async () => {
    const service = createService(REVIEW_EXTRACTION, true, async () => {
      throw new Error("https://private.example/session/transcript");
    });

    const result = await service.sweep();

    expect(result.errors).toEqual([{ message_id: "message-1", error: "Error" }]);
    expect(messages.find("message-1")).toMatchObject({ outcome: "error", error: "Error" });
  });

  function createService(
    extraction: PdfExtraction,
    withSource = true,
    extractPdf: (data: Buffer, issuer: string | null) => Promise<PdfExtraction> = async () => extraction,
  ): MailIntakeService {
    return new MailIntakeService({
      source: withSource ? source : undefined,
      messages,
      documents,
      receipts,
      intake: new ReceiptIntake({
        db,
        receipts,
        reconciliations: new ReconciliationsRepo(db),
      }),
      notifications,
      config: {
        enabled: true,
        query: "in:inbox",
        documentsRoot,
        maxAttachmentBytes: 1024,
        rules: [
          { kind: "cloud_notice", fromDomains: ["cloud.example"] },
          { kind: "invoice", attachmentMime: ["application/pdf"] },
        ],
      },
      extractPdf,
    });
  }
});

function invoiceMessage(): MailMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    from: { name: "Example", address: "billing@example.com" },
    to: ["recipient@example.test"],
    subject: "Invoice https://private.example/link",
    date: new Date("2026-09-01T00:00:00Z"),
    text: "private body",
    snippet: "private snippet",
    labelIds: ["INBOX"],
    attachments: [{
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 3,
      attachmentId: "attachment-1",
    }],
    headers: {},
  };
}

function cloudMessage(): MailMessage {
  return {
    ...invoiceMessage(),
    id: "cloud-1",
    threadId: "cloud-thread-1",
    from: { address: "alerts@cloud.example" },
    subject: "Cloud billing alert",
    attachments: [],
  };
}

function mailSource(messages: MailMessage[]): MailSource {
  return {
    search: vi.fn(async () => messages),
    get: vi.fn(async (id: string) => messages.find((message) => message.id === id) ?? null),
    loadAttachment: vi.fn(async () => Buffer.from("pdf")),
  };
}

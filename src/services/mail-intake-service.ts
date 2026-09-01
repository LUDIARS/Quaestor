import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MailMessage, MailSource } from "@ludiars/mail-inbox";
import type { InboundDocumentsRepo } from "../db/inbound-documents-repo.js";
import type { MailKind, MailMessagesRepo } from "../db/mail-messages-repo.js";
import type { ReceiptsRepo } from "../db/receipts-repo.js";
import { classifyMail, type MailRule } from "../mail/classify.js";
import { extractInvoicePdf, type PdfExtraction } from "../mail/pdf-extract.js";
import type { MailNotice } from "./mail-notices.js";
import type { NotificationService } from "./notification-service.js";
import type { ReceiptIntake } from "./receipt-intake.js";

export interface MailIntakeConfig {
  enabled: boolean;
  query: string;
  documentsRoot: string;
  maxAttachmentBytes: number;
  rules: MailRule[];
}

export interface MailSweepResult {
  fetched: number;
  processed: Record<MailKind, number>;
  committed: number;
  needs_review: number;
  notified: number;
  errors: { message_id: string; error: string }[];
  disabled?: boolean;
  reason?: string;
  notifications?: "disabled";
}

export interface MailIntakeDeps {
  source?: MailSource;
  messages: MailMessagesRepo;
  documents: InboundDocumentsRepo;
  receipts: ReceiptsRepo;
  intake: ReceiptIntake;
  notifications: NotificationService;
  config: MailIntakeConfig;
  extractPdf?: (data: Buffer, issuer: string | null) => Promise<PdfExtraction>;
}

interface ProcessedMail {
  outcome: string;
  notice?: MailNotice;
}

export class MailIntakeService {
  /** @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md) */
  constructor(private readonly deps: MailIntakeDeps) {}

  /**
   * @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md)
   * @implements SPEC-MAIL-INTAKE-003 (spec/feature/mail-intake.md)
   * @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md)
   */
  async sweep(opts: { dry_run?: boolean } = {}): Promise<MailSweepResult> {
    const disabledReason = this.disabledReason();
    if (disabledReason) return resultDisabled(disabledReason);
    const source = this.deps.source;
    if (!source) return resultDisabled("QUAESTOR_GMAIL_* is not configured");

    let messages: MailMessage[];
    try {
      messages = await source.search(this.deps.config.query, {
        loadAttachments: false,
        maxAttachmentBytes: this.deps.config.maxAttachmentBytes,
      });
    } catch (error) {
      const result = emptyResult(0);
      result.errors.push({ message_id: "*", error: safeErrorKind(error) });
      return result;
    }
    const result = emptyResult(messages.length);

    for (const message of messages) {
      if (this.deps.messages.find(message.id)) continue;
      const classified = classifyMail(message, this.deps.config.rules);

      if (opts.dry_run) {
        result.processed[classified.kind]++;
        try {
          await this.process(message, classified.kind, false, result);
        } catch (error) {
          result.errors.push({ message_id: message.id, error: safeErrorKind(error) });
        }
        continue;
      }

      const claimed = this.deps.messages.claim({
        message_id: message.id,
        thread_id: message.threadId,
        received_at: Math.floor(message.date.getTime() / 1000),
        from_address: message.from.address,
        subject: redactUrls(message.subject),
        kind: classified.kind,
        rule_index: classified.ruleIndex,
        outcome: "processing",
        error: null,
        processed_at: nowSec(),
      });
      if (!claimed) continue;

      result.processed[classified.kind]++;
      try {
        const processed = await this.process(message, classified.kind, true, result);
        let outcome = processed.outcome;
        if (processed.notice) {
          const notification = await this.notify(classified.kind, processed.notice, result);
          if (classified.kind === "cloud_notice") {
            outcome = notification === "sent" ? "notified" : `notification_${notification}`;
          } else if (notification !== "sent") {
            outcome = `${outcome}; notification_${notification}`;
          }
        }
        this.deps.messages.updateOutcome(message.id, outcome, null);
      } catch (error) {
        const errorKind = safeErrorKind(error);
        this.deps.messages.updateOutcome(message.id, "error", errorKind);
        result.errors.push({ message_id: message.id, error: errorKind });
      }
    }

    return result;
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  async commitDocument(
    id: string,
    input: { payee: string; date: string; total: number },
  ): Promise<string | null> {
    const document = this.deps.documents.claimForCommit(id);
    if (!document) return null;
    try {
      const receiptId = this.createReceipt(
        document.message_id,
        document.id,
        input.payee,
        input.date,
        input.total,
        document.extracted,
      );
      this.deps.documents.update(id, "committed", receiptId);
      return receiptId;
    } catch (error) {
      this.deps.documents.update(id, "needs_review");
      throw error;
    }
  }

  /**
   * @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md)
   * @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md)
   */
  private async process(
    message: MailMessage,
    kind: MailKind,
    persist: boolean,
    result: MailSweepResult,
  ): Promise<ProcessedMail> {
    if (kind === "ignore") return { outcome: "ignored" };
    if (kind === "cloud_notice") {
      return { outcome: "cloud_notice", notice: this.notice(message, "cloud_notice") };
    }

    const pdf = message.attachments.find(
      (attachment) => attachment.mimeType.toLowerCase() === "application/pdf"
        && attachment.size >= 0
        && attachment.size <= this.deps.config.maxAttachmentBytes,
    );
    if (!pdf) {
      result.needs_review++;
      return { outcome: "needs_review", notice: this.notice(message, "needs_review") };
    }

    const pdfData = pdf.data ?? await this.deps.source?.loadAttachment(message.id, pdf.attachmentId);
    if (!pdfData || pdfData.byteLength > this.deps.config.maxAttachmentBytes) {
      result.needs_review++;
      return { outcome: "needs_review", notice: this.notice(message, "needs_review", pdf.filename) };
    }

    const hash = createHash("sha256").update(pdfData).digest("hex");
    if (this.deps.documents.findByHash(hash)) {
      return { outcome: "duplicate", notice: this.notice(message, "duplicate", pdf.filename) };
    }

    const issuer = message.from.name ?? message.from.address.split("@")[0] ?? null;
    const extraction = await (this.deps.extractPdf ?? extractInvoicePdf)(pdfData, issuer);
    const completeExtraction = isCompleteExtraction(extraction) ? extraction : null;
    const status = completeExtraction ? "committed" : "needs_review";
    if (!persist) {
      result[status]++;
      return { outcome: status, notice: this.notice(message, status, pdf.filename, extraction) };
    }

    const documentId = randomUUID();
    const year = String(message.date.getUTCFullYear());
    const month = String(message.date.getUTCMonth() + 1).padStart(2, "0");
    const relativePath = join(year, month, `${documentId}.pdf`);
    const absolutePath = join(this.deps.config.documentsRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, pdfData);

    try {
      this.deps.documents.insert({
        id: documentId,
        message_id: message.id,
        filename: redactUrls(pdf.filename),
        mime_type: "application/pdf",
        file_path: relativePath,
        sha256: hash,
        size: pdfData.length,
        extracted: JSON.stringify(extraction),
        status: "needs_review",
      });
    } catch (error) {
      await unlink(absolutePath).catch(() => { /* best-effort cleanup after failed DB insert */ });
      throw error;
    }

    if (!completeExtraction) {
      result.needs_review++;
      return {
        outcome: "needs_review",
        notice: this.notice(message, "needs_review", pdf.filename, extraction),
      };
    }

    const receiptId = this.createReceipt(
      message.id,
      documentId,
      completeExtraction.issuer,
      completeExtraction.date,
      completeExtraction.total,
      JSON.stringify(extraction),
    );
    this.deps.documents.update(documentId, "committed", receiptId);
    result.committed++;
    const outcome = `committed: receipt ${receiptId}`;
    return { outcome, notice: this.notice(message, outcome, pdf.filename, extraction) };
  }

  /** @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md) */
  private async notify(
    kind: MailKind,
    notice: MailNotice,
    result: MailSweepResult,
  ): Promise<"sent" | "disabled" | "skipped" | "failed"> {
    const sent = kind === "invoice"
      ? await this.deps.notifications.notifyMailInvoice(notice)
      : await this.deps.notifications.notifyMailCloudNotice(notice);
    if (sent.sent) {
      result.notified++;
      return "sent";
    }
    if (sent.disabled) {
      result.notifications = "disabled";
      return "disabled";
    }
    return sent.skipped ? "skipped" : "failed";
  }

  /** @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md) */
  private notice(
    message: MailMessage,
    outcome: string,
    filename?: string,
    extraction?: PdfExtraction,
  ): MailNotice {
    return {
      messageId: message.id,
      from: message.from.name
        ? `${message.from.name} <${message.from.address}>`
        : message.from.address,
      subject: message.subject,
      receivedAt: Math.floor(message.date.getTime() / 1000),
      filename,
      extraction,
      outcome,
    };
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  private createReceipt(
    messageId: string,
    documentId: string,
    payee: string,
    date: string,
    total: number,
    extracted: string | null,
  ): string {
    const id = this.deps.receipts.insert({
      metadata: {
        ...readMeta(extracted),
        source: "mail-inbox",
        inbound_document_id: documentId,
        message_id: messageId,
      },
    });
    this.deps.receipts.setOcrResult(id, { ocr_status: "manual", payee, date, total, items: [] });
    this.deps.intake.afterOcr(id);
    return id;
  }

  /** @implements SPEC-MAIL-INTAKE-003 (spec/feature/mail-intake.md) */
  private disabledReason(): string | null {
    if (!this.deps.config.enabled) return "mailIntake.enabled=false";
    return null;
  }
}

/** @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md) */
function readMeta(value: string | null): Record<string, unknown> {
  try {
    return value ? JSON.parse(value) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function emptyResult(fetched: number): MailSweepResult {
  return {
    fetched,
    processed: { invoice: 0, cloud_notice: 0, ignore: 0 },
    committed: 0,
    needs_review: 0,
    notified: 0,
    errors: [],
  };
}

/** @implements SPEC-MAIL-INTAKE-003 (spec/feature/mail-intake.md) */
function resultDisabled(reason: string): MailSweepResult {
  return { ...emptyResult(0), disabled: true, reason };
}

function safeErrorKind(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    const kind = String((error as { kind?: unknown }).kind ?? "");
    if (["auth", "rate_limit", "not_found", "network", "invalid_response"].includes(kind)) {
      return `mail_${kind}`;
    }
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (/^[A-Z0-9_]{1,32}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) return error.name;
  return "processing_error";
}

/** @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md) */
function redactUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[URL omitted]");
}

function isCompleteExtraction(
  extraction: PdfExtraction,
): extraction is PdfExtraction & { issuer: string; date: string; total: number } {
  return extraction.confidence === "high"
    && !!extraction.issuer?.trim()
    && !!extraction.date
    && extraction.total !== null
    && extraction.total > 0;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

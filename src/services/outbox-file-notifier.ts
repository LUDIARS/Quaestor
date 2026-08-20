/**
 * ローカルテストモード専用のメール代替。 SES へは一切出さず、 送信内容を
 * `app_data/outbox/` 配下のテキストファイル (添付は隣の実ファイル) として書き出す。
 * マジックリンク・確認コード・証跡バンドルを、 実メールなしで検証者が読めるようにする。
 *
 * 本番経路では使わない: server.ts が `invoiceShare.localTest` のときだけ組み立てる。
 *
 * @implements SPEC-INVOICE-LOCALTEST-001 (spec/feature/invoice-public-magic-link.md)
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InvoiceEmailMessage,
  InvoiceEmailNotifier,
  InvoiceEmailSendResult,
} from "./invoice-email-notifier.js";

export const DEFAULT_OUTBOX_DIR = "app_data/outbox";

export class OutboxFileNotifier implements InvoiceEmailNotifier {
  private readonly dir: string;
  private readonly now: () => Date;
  private sequence = 0;

  /** @implements SPEC-INVOICE-LOCALTEST-001 (spec/feature/invoice-public-magic-link.md) */
  constructor(options: { dir?: string; now?: () => Date } = {}) {
    this.dir = options.dir ?? DEFAULT_OUTBOX_DIR;
    this.now = options.now ?? (() => new Date());
  }

  /** @implements SPEC-INVOICE-LOCALTEST-001 (spec/feature/invoice-public-magic-link.md) */
  assertReady(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** @implements SPEC-INVOICE-LOCALTEST-001 (spec/feature/invoice-public-magic-link.md) */
  async sendMessage(message: InvoiceEmailMessage): Promise<InvoiceEmailSendResult> {
    this.assertReady();
    this.sequence += 1;
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const base = `${stamp}-${String(this.sequence).padStart(3, "0")}-${randomUUID()}`;
    const attachmentNotes: string[] = [];
    for (const [index, attachment] of (message.attachments ?? []).entries()) {
      const filename = `${base}-attachment-${index + 1}-${sanitize(attachment.filename)}`;
      writeFileSync(join(this.dir, filename), attachment.content, { flag: "wx" });
      attachmentNotes.push(`Attachment: ${filename} (${attachment.contentType})`);
    }
    const body = [
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      ...attachmentNotes,
      "",
      message.text,
      "",
    ].join("\n");
    const messageId = `outbox-${base}`;
    writeFileSync(join(this.dir, `${base}.txt`), body, { encoding: "utf8", flag: "wx" });
    return { messageId };
  }
}

/** @implements SPEC-INVOICE-LOCALTEST-001 (spec/feature/invoice-public-magic-link.md) */
function sanitize(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 80) || "attachment";
}

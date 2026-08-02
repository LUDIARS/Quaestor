/**
 * マジックリンク発行と Slack 投稿の結合サービス。
 *
 * @implements SPEC-INVOICE-SLACK-002 (spec/feature/invoice-public-magic-link.md)
 */

import type { InvoiceRow, InvoicesRepo } from "../db/invoices-repo.js";
import { InvoiceShareError, type CreatedInvoiceShare, type InvoiceShareService } from "./invoice-share-service.js";
import {
  SlackDeliveryError,
  type SlackInvoiceNotifier,
  type SlackInvoiceTarget,
  type SlackPostResult,
} from "./slack-web-api-client.js";

export interface DeliverInvoiceToSlackInput {
  invoiceId: number;
  documentPath: string;
  expiresInDays?: number;
  target?: SlackInvoiceTarget;
  recipientName?: string;
  billingPeriod?: string;
  deliveryContactId?: string;
}

export interface DeliveredInvoiceToSlack extends CreatedInvoiceShare, SlackPostResult {}

export interface InvoiceSlackDeliveryOptions {
  invoices: InvoicesRepo;
  shares: InvoiceShareService;
  notifier?: SlackInvoiceNotifier;
  defaultTarget?: SlackInvoiceTarget;
}

/** マジックリンク発行と Slack 投稿を一つの失敗単位として扱う。 */
export class InvoiceSlackDeliveryService {
  constructor(private readonly options: InvoiceSlackDeliveryOptions) {}

  async deliver(input: DeliverInvoiceToSlackInput): Promise<DeliveredInvoiceToSlack> {
    const notifier = this.options.notifier;
    if (!notifier) {
      throw new SlackDeliveryError("not_configured", "Slack bot token is not configured", 503);
    }
    const target = input.target ?? this.options.defaultTarget;
    if (!target) {
      throw new SlackDeliveryError("not_configured", "Slack group DM target is not configured", 503);
    }
    notifier.assertReady(target);

    const invoice = this.options.invoices.find(input.invoiceId);
    if (!invoice || invoice.status === "cancelled") {
      throw new InvoiceShareError("not_found", "invoice not found", 404);
    }
    const share = await this.options.shares.create({
      invoiceId: input.invoiceId,
      documentPath: input.documentPath,
      expiresInDays: input.expiresInDays,
      recipientId: input.deliveryContactId,
    });
    try {
      const posted = await notifier.postMessage({
        target,
        ...invoiceMessage(invoice, share, input.recipientName, input.billingPeriod),
      });
      return { ...share, ...posted };
    } catch (error) {
      // 失効に失敗しても投稿失敗そのものを握り潰さない (502 が 500 に化けるのを防ぐ)。
      try {
        this.options.shares.revoke(input.invoiceId, share.id);
      } catch { /* 失効失敗はリンク期限切れに委ねる */ }
      throw error;
    }
  }
}

function invoiceMessage(
  invoice: InvoiceRow,
  share: CreatedInvoiceShare,
  recipientName?: string,
  billingPeriod?: string,
): { text: string; blocks: Record<string, unknown>[] } {
  const addressee = recipientName?.trim()
    || `${share.recipientCompany ?? invoice.client} ご担当者様`;
  const subject = billingPeriod?.trim() || invoice.work_summary;
  const expiresAt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(share.expiresAt * 1000));
  // fallback text も Slack は mrkdwn として解釈する。 宛名・件名は請求先入力由来なので
  // `<https://…|請求書>` のような偽装リンクを作らせないよう blocks と同じ規則で escape する。
  const text = [
    `${escapeMrkdwn(addressee)}`,
    `${escapeMrkdwn(subject)}の請求書をご用意しました。`,
    `請求書を確認する: ${share.url}`,
    `リンク有効期限: ${escapeMrkdwn(expiresAt)}`,
  ].join("\n");
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeMrkdwn(addressee)}*\n${escapeMrkdwn(subject)}の請求書をご用意しました。`,
        },
      },
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "請求書を確認する", emoji: true },
          url: share.url,
          action_id: "open_invoice_share",
        }],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `リンク有効期限: ${escapeMrkdwn(expiresAt)}` }],
      },
    ],
  };
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

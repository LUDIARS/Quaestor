/**
 * 請求書メール配信の抽象。 実装は Gmail ADC、テストは注入したダブル。
 *
 * @implements SPEC-INVOICE-EMAIL-001 (spec/feature/invoice-public-magic-link.md)
 */

export interface InvoiceEmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface InvoiceEmailSendResult {
  messageId: string;
}

export interface InvoiceEmailNotifier {
  assertReady(): void;
  sendMessage(message: InvoiceEmailMessage): Promise<InvoiceEmailSendResult>;
}

export class InvoiceEmailError extends Error {
  constructor(
    readonly code: "not_configured" | "authentication_failed" | "api_error",
    message: string,
    readonly status: 502 | 503,
  ) {
    super(message);
  }
}

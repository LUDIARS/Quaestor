/**
 * 合意直後に受領者へ証跡バンドルを添付で送る。 送信失敗は合意を取り消さない (バンドルは
 * マジックリンクの `?view=evidence` からも再取得できる)。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-007 (spec/feature/invoice-public-magic-link.md)
 */

import type { InvoiceAcceptanceEvidenceBundle } from "./invoice-acceptance-evidence-bundle.js";
import { evidenceBundleFilename } from "./invoice-acceptance-evidence-bundle.js";
import type { InvoiceEmailNotifier } from "./invoice-email-notifier.js";

export interface InvoiceAcceptanceEvidenceMailerOptions {
  notifier?: InvoiceEmailNotifier;
  onError?: (shareId: string, error: unknown) => void;
}

export class InvoiceAcceptanceEvidenceMailer {
  constructor(private readonly options: InvoiceAcceptanceEvidenceMailerOptions) {}

  /** 送れたら true。 notifier 未設定・宛先無し・送信失敗は false (例外は投げない)。 */
  async send(input: {
    to: string | null;
    recipientCompany: string | null;
    shareId: string;
    bundle: InvoiceAcceptanceEvidenceBundle;
    evidenceUrl: string;
  }): Promise<boolean> {
    const notifier = this.options.notifier;
    if (!notifier || !input.to) return false;
    const pendingNote = input.bundle.timestamp.status === "granted"
      ? "外部タイムスタンプ局 (RFC 3161) による時刻証明を同梱しています。"
      : "外部タイムスタンプは後追いで付与されます。付与後の最新版は下記リンクから再取得できます。";
    try {
      notifier.assertReady();
      await notifier.sendMessage({
        to: input.to,
        subject: "【Qs】請求内容への合意の控え (署名証跡)",
        text: [
          `${input.recipientCompany ?? ""} ご担当者様`.trim(),
          "",
          "請求内容への合意をパスキー署名で受け付けました。添付の JSON はお手元で保管できる合意の証跡です。",
          "署名・公開鍵・請求書 PDF のハッシュ・合意文言を含み、送信元のデータベースに依存せず第三者が検証できます。",
          pendingNote,
          "",
          `文書識別子: ${input.bundle.acceptance.document_sha256.slice(0, 16)}`,
          `公開鍵指紋: ${input.bundle.credential.public_key_sha256.slice(0, 16)}`,
          `再取得 (リンク有効期限内): ${input.evidenceUrl}`,
          "",
          "検証手順は添付 JSON の verify 欄を参照してください。",
        ].join("\n"),
        attachments: [{
          filename: evidenceBundleFilename(input.shareId),
          contentType: "application/json",
          content: Buffer.from(JSON.stringify(input.bundle, null, 2), "utf8"),
        }],
      });
      return true;
    } catch (error) {
      this.options.onError?.(input.shareId, error);
      return false;
    }
  }
}

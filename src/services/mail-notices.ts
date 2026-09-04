import type { DiscordMessage } from "./discord-notifier.js";
import type { PdfExtraction } from "../mail/pdf-extract.js";

export interface MailNotice {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: number;
  filename?: string;
  extraction?: PdfExtraction;
  outcome: string;
}

export interface BuiltMailNotice {
  message: DiscordMessage;
  dedupKey: string;
  hasContent: boolean;
}

/**
 * @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md)
 * @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md)
 */
export function buildMailInvoiceNotice(notice: MailNotice): BuiltMailNotice {
  return build(notice, "📬 請求書メール");
}

/**
 * @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md)
 * @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md)
 */
export function buildMailCloudNotice(notice: MailNotice): BuiltMailNotice {
  return build(notice, "☁️ クラウドメール");
}

/**
 * @implements SPEC-MAIL-INTAKE-002 (spec/feature/mail-intake.md)
 * @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md)
 */
function build(notice: MailNotice, title: string): BuiltMailNotice {
  const extraction = notice.extraction;
  return {
    message: {
      embeds: [{
        title,
        fields: [
          { name: "差出人", value: fieldValue(notice.from), inline: true },
          { name: "件名", value: fieldValue(notice.subject) },
          { name: "受信日時", value: new Date(notice.receivedAt * 1000).toISOString(), inline: true },
          { name: "添付", value: fieldValue(notice.filename), inline: true },
          { name: "発行元", value: fieldValue(extraction?.issuer), inline: true },
          {
            name: "金額",
            value: extraction?.total == null ? "—" : `¥${extraction.total.toLocaleString("ja-JP")}`,
            inline: true,
          },
          { name: "支払期限", value: fieldValue(extraction?.due_date), inline: true },
          { name: "請求書番号", value: fieldValue(extraction?.invoice_no), inline: true },
          { name: "取り込み結果", value: fieldValue(notice.outcome) },
        ],
      }],
    },
    dedupKey: notice.messageId,
    hasContent: true,
  };
}

function fieldValue(value: string | null | undefined): string {
  if (!value) return "—";
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, "[URL omitted]");
  return withoutUrls.slice(0, 1024) || "—";
}

/**
 * CI 失敗 / Dependabot 通知メールを検知したときの Discord 通知。
 *
 * throttle で委託の起動を見送ったときも必ず送り、 `skipped` を明記する。
 * 「通知が無い = そのメールが来ていない」 という読み方を壊さないため
 * (SPEC-MAIL-INTAKE-006 と同じ考え方)。
 */
export interface MailActionNotice {
  messageId: string;
  kind: "ci_failure" | "dependabot";
  subject: string;
  receivedAt: number;
  repo: string | null;
  workflow?: string | null;
  headSha?: string | null;
  runUrl?: string | null;
  /** 起動できたときの delegation run id */
  runId?: string | null;
  /** 起動を見送った理由。 未設定なら起動済み */
  skipped?: string | null;
}

const ACTION_TITLES: Record<MailActionNotice["kind"], string> = {
  ci_failure: "🔧 CI 失敗メール",
  dependabot: "📦 Dependabot 通知",
};

/** @implements SPEC-MAIL-REALTIME-007 (spec/feature/mail-realtime.md) */
export function buildMailActionNotice(notice: MailActionNotice): BuiltMailNotice {
  return {
    message: {
      embeds: [{
        title: ACTION_TITLES[notice.kind],
        fields: [
          { name: "リポジトリ", value: fieldValue(notice.repo), inline: true },
          { name: "workflow", value: fieldValue(notice.workflow), inline: true },
          { name: "head sha", value: fieldValue(notice.headSha), inline: true },
          { name: "件名", value: fieldValue(notice.subject) },
          { name: "受信日時", value: new Date(notice.receivedAt * 1000).toISOString(), inline: true },
          {
            name: "起動",
            value: notice.skipped
              ? `skipped: ${notice.skipped}`
              : `invoked${notice.runId ? ` (run ${notice.runId})` : ""}`,
          },
        ],
      }],
    },
    dedupKey: notice.messageId,
    hasContent: true,
  };
}

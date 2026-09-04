import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MailMessage, MailSource } from "@ludiars/mail-inbox";
import type { InboundDocumentsRepo } from "../db/inbound-documents-repo.js";
import type { MailKind, MailMessagesRepo } from "../db/mail-messages-repo.js";
import type { MailWatchStateRepo } from "../db/mail-watch-state-repo.js";
import type { ReceiptsRepo } from "../db/receipts-repo.js";
import { classifyMail, type MailRule } from "../mail/classify.js";
import { extractInvoicePdf, type PdfExtraction } from "../mail/pdf-extract.js";
import type { MailActionKind, MailActionResult } from "./mail-actions.js";
import type { MailNotice } from "./mail-notices.js";
import type { NotificationService } from "./notification-service.js";
import type { ReceiptIntake } from "./receipt-intake.js";

/** Gmail Pub/Sub リアルタイム受信の設定 (spec/feature/mail-realtime.md) */
export interface MailRealtimeConfig {
  enabled: boolean;
  /** projects/<project>/topics/<name> */
  topicName: string | null;
  /** projects/<project>/subscriptions/<name> */
  subscriptionName: string | null;
  labelIds: string[];
  /** ci_failure で委託を起動してよいリポジトリ (owner/name、 末尾 /* で owner 配下すべて) */
  repoAllowlist: string[];
}

export interface MailIntakeConfig {
  enabled: boolean;
  query: string;
  documentsRoot: string;
  maxAttachmentBytes: number;
  rules: MailRule[];
  /** 省略時はリアルタイム受信を行わない (cron sweep のみ) */
  realtime?: MailRealtimeConfig;
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

/** 検知後の起動 (mail-actions)。 テストと realtime 無効時のために任意依存にする。 */
export interface MailActionRunner {
  handle(message: MailMessage, kind: MailActionKind): Promise<MailActionResult>;
}

/** history 差分同期の結果。 sweep の集計に基準点の情報を足したもの。 */
export interface MailSyncResult extends MailSweepResult {
  /** 初回は基準点を作るだけで差分は取らない */
  initialized: boolean;
  /** history が失効したので全件 sweep へ落ちた */
  fell_back: boolean;
  history_id: string | null;
}

export interface MailIntakeDeps {
  source?: MailSource;
  /** realtime の基準点。 省略時 syncFromHistory は disabled を返す */
  watchState?: MailWatchStateRepo;
  /** ci_failure / dependabot を検知したときの起動 */
  actions?: MailActionRunner;
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
  /** history 同期を直列化する in-process mutex (Promise chain 1 本)。 */
  private syncChain: Promise<MailSyncResult> = Promise.resolve(emptySyncResult());

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
    await this.processMessages(messages, opts, result);
    return result;
  }

  /**
   * Gmail の history 差分だけを取り込む (Pub/Sub 通知のトリガから呼ばれる)。
   *
   * 基準点は通知内の historyId ではなく DB の mail_watch_state.history_id とする
   * (Pub/Sub に順序保証が無いため)。 cron sweep と重なるので in-process の mutex 1 本で
   * 直列化し、 history_id の巻き戻りを防ぐ (二重処理自体は claim() が原子的に防ぐ)。
   *
   * @implements SPEC-MAIL-REALTIME-001 (spec/feature/mail-realtime.md)
   * @implements SPEC-MAIL-REALTIME-002 (spec/feature/mail-realtime.md)
   * @implements SPEC-MAIL-REALTIME-003 (spec/feature/mail-realtime.md)
   * @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md)
   */
  async syncFromHistory(): Promise<MailSyncResult> {
    const next = this.syncChain.then(
      () => this.runSyncFromHistory(),
      () => this.runSyncFromHistory(),
    );
    this.syncChain = next;
    return next;
  }

  private async runSyncFromHistory(): Promise<MailSyncResult> {
    const disabledReason = this.realtimeDisabledReason();
    if (disabledReason) return syncDisabled(disabledReason);
    const source = this.deps.source as MailSource;
    const watchState = this.deps.watchState as MailWatchStateRepo;

    const startHistoryId = watchState.get()?.history_id ?? null;
    if (!startHistoryId) {
      // 初回は差分の基準を作るだけ。 過去メールは cron sweep が拾う。
      const historyId = await source.currentHistoryId();
      watchState.setHistoryId(historyId);
      return { ...emptySyncResult(), initialized: true, history_id: historyId };
    }

    const page = await source.history(startHistoryId, {
      historyTypes: ["messageAdded"],
      labelIds: this.deps.config.realtime?.labelIds,
    });

    if (page.expired) {
      // 差分の基準が失効した。 取りこぼさないよう全件 sweep へ落とし、 基準を貼り直す。
      const swept = await this.sweep();
      const historyId = await source.currentHistoryId();
      watchState.setHistoryId(historyId);
      return { ...swept, initialized: false, fell_back: true, history_id: historyId };
    }

    const messageIds = [...new Set(
      page.changes.filter((change) => change.type === "added").map((change) => change.messageId),
    )];
    const messages: MailMessage[] = [];
    let retrievalFailed = false;
    const result: MailSyncResult = {
      ...emptySyncResult(),
      fetched: messageIds.length,
      history_id: page.historyId,
    };
    for (const id of messageIds) {
      if (this.deps.messages.find(id)) continue;
      try {
        const message = await source.get(id, {
          loadAttachments: false,
          maxAttachmentBytes: this.deps.config.maxAttachmentBytes,
        });
        if (message) messages.push(message);
      } catch (error) {
        retrievalFailed = true;
        result.errors.push({ message_id: id, error: safeErrorKind(error) });
      }
    }

    await this.processMessages(messages, {}, result);
    if (retrievalFailed) {
      // 一時的な取得失敗を次回通知で再試行できるよう、基準点を進めない。
      result.history_id = startHistoryId;
      return result;
    }
    watchState.setHistoryId(page.historyId);
    return result;
  }

  /**
   * 取得済みメッセージの分類・取り込み・通知。 sweep と syncFromHistory の共通処理。
   *
   * @implements SPEC-MAIL-INTAKE-001 (spec/feature/mail-intake.md)
   * @implements SPEC-MAIL-INTAKE-005 (spec/feature/mail-intake.md)
   * @implements SPEC-MAIL-REALTIME-003 (spec/feature/mail-realtime.md)
   */
  private async processMessages(
    messages: MailMessage[],
    opts: { dry_run?: boolean },
    result: MailSweepResult,
  ): Promise<void> {
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
  }

  /** @implements SPEC-MAIL-INTAKE-004 (spec/feature/mail-intake.md) */
  async commitDocument(
    id: string,
    input: { payee: string; date: string; total: number },
  ): Promise<string | null> {
    const document = this.deps.documents.claimForCommit(id);
    if (!document) return null;
    if (document.source !== "mail" || !document.message_id) {
      this.deps.documents.update(id, "needs_review");
      return null;
    }
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
    // GitHub 通知は添付を見ない。 起動と Discord 通知は mail-actions が持つ
    // (throttle で起動を見送ったときも必ず通知する)。
    if (kind === "ci_failure" || kind === "dependabot") {
      if (!persist) return { outcome: `${kind}; skipped: dry_run` };
      if (!this.deps.actions) return { outcome: kind + "; skipped: disabled" };
      const action = await this.deps.actions.handle(message, kind);
      if (action.notified) result.notified++;
      return { outcome: action.outcome };
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

  /**
   * 鍵・設定が欠けているときは成功と区別できるよう理由付きで disabled にする。
   * @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md)
   */
  realtimeDisabledReason(): string | null {
    const base = this.disabledReason();
    if (base) return base;
    if (!this.deps.config.realtime?.enabled) return "mailIntake.realtime.enabled=false";
    if (!this.deps.source) return "QUAESTOR_GMAIL_* is not configured";
    if (!this.deps.watchState) return "mail watch state is not available";
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
    processed: { invoice: 0, cloud_notice: 0, ci_failure: 0, dependabot: 0, ignore: 0 },
    committed: 0,
    needs_review: 0,
    notified: 0,
    errors: [],
  };
}

function emptySyncResult(): MailSyncResult {
  return { ...emptyResult(0), initialized: false, fell_back: false, history_id: null };
}

/** @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md) */
function syncDisabled(reason: string): MailSyncResult {
  return { ...emptySyncResult(), disabled: true, reason };
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

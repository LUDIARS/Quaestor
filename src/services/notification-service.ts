/**
 * アドバイザーのアドバイスを Discord に通知するオーケストレーション。
 * オンデマンド (force=送信) と定期 (dedup=前回と同内容なら skip) の両方を担う。
 */

import type { DiscordNotifier } from "./discord-notifier.js";
import type { NotificationState } from "./notification-state.js";
import type { Suggestion } from "./invest-advisor.js";
import type { DividendCandidateRow } from "../db/dividend-candidates-repo.js";
import type { SubsidySuggestion } from "./subsidy-advisor.js";
import { buildInvestAdvice, buildDividendAdvice, buildSubsidyAdvice, type BuiltAdvice } from "./advice-notifications.js";
import { buildInvoiceNotice } from "./invoice-notice.js";
import type { InvoiceRow } from "../db/invoices-repo.js";
import {
  buildMailActionNotice, buildMailCloudNotice, buildMailInvoiceNotice,
  type MailActionNotice, type MailNotice,
} from "./mail-notices.js";

export interface NotifyResult {
  sent: boolean;
  skipped?: boolean;
  disabled?: boolean;
  notFound?: boolean;
  reason?: string;
}

export interface NotifyOptions {
  /** true = 前回と同内容なら送らない (定期通知用)。 false/未指定 = 常に送る (オンデマンド) */
  dedup?: boolean;
}

export interface NotificationServiceDeps {
  notifier?: DiscordNotifier;
  state: NotificationState;
  investSuggestions: () => Suggestion[];
  dividendCandidates: () => DividendCandidateRow[];
  /** 補助金: planId からサジェストを実行 (crawl+LLM)。 計画名も返す */
  subsidySuggest: (planId: string) => Promise<{ planName: string; suggestions: SubsidySuggestion[] }>;
  /** 請求書 1 件の取得 (通知対象。 見つからなければ null) */
  findInvoice: (id: number) => InvoiceRow | null;
}

export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  async notifyInvest(opts: NotifyOptions = {}): Promise<NotifyResult> {
    return this.dispatch("invest", buildInvestAdvice(this.deps.investSuggestions()), opts);
  }

  async notifyDividends(opts: NotifyOptions = {}): Promise<NotifyResult> {
    return this.dispatch("dividend", buildDividendAdvice(this.deps.dividendCandidates()), opts);
  }

  async notifySubsidies(planId: string, opts: NotifyOptions = {}): Promise<NotifyResult> {
    const { planName, suggestions } = await this.deps.subsidySuggest(planId);
    return this.dispatch(`subsidy:${planId}`, buildSubsidyAdvice(planName, suggestions), opts);
  }

  /**
   * 請求書 1 件を通知する。 月末の自動作成分を人が確認するための経路で、
   * 存在しない id は送信ではなく not_found として返す (無言で成功にしない)。
   * @implements SPEC-INVOICE-NOTICE-001 (spec/feature/invoice-discord-notice.md)
   * @implements SPEC-INVOICE-NOTICE-002 (spec/feature/invoice-discord-notice.md)
   */
  async notifyInvoice(invoiceId: number, opts: NotifyOptions = {}): Promise<NotifyResult> {
    const invoice = this.deps.findInvoice(invoiceId);
    if (!invoice) return { sent: false, notFound: true, reason: "invoice not_found" };
    return this.dispatch(`invoice:${invoiceId}`, buildInvoiceNotice(invoice), opts);
  }
  /** @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md) */
  async notifyMailInvoice(notice: MailNotice): Promise<NotifyResult> {
    return this.dispatch(
      `mail:${notice.messageId}`,
      buildMailInvoiceNotice(notice),
      { dedup: true },
    );
  }

  /** @implements SPEC-MAIL-INTAKE-006 (spec/feature/mail-intake.md) */
  async notifyMailCloudNotice(notice: MailNotice): Promise<NotifyResult> {
    return this.dispatch(
      `mail:${notice.messageId}`,
      buildMailCloudNotice(notice),
      { dedup: true },
    );
  }

  /**
   * CI 失敗 / Dependabot の検知通知。 委託の起動を throttle で見送ったときも送る。
   * @implements SPEC-MAIL-REALTIME-007 (spec/feature/mail-realtime.md)
   */
  async notifyMailAction(notice: MailActionNotice): Promise<NotifyResult> {
    return this.dispatch(
      `mail:${notice.messageId}`,
      buildMailActionNotice(notice),
      { dedup: true },
    );
  }

  private async dispatch(channel: string, built: BuiltAdvice, opts: NotifyOptions): Promise<NotifyResult> {
    if (!this.deps.notifier?.enabled) {
      return { sent: false, disabled: true, reason: "Discord webhook 未設定 (secret QUAESTOR_DISCORD_WEBHOOK_URL)" };
    }
    if (!built.hasContent) {
      return { sent: false, skipped: true, reason: "通知に値する項目がありません" };
    }
    if (opts.dedup && this.deps.state.isSame(channel, built.dedupKey)) {
      return { sent: false, skipped: true, reason: "前回と同内容のため送信省略" };
    }
    const ok = await this.deps.notifier.send(built.message);
    if (ok) this.deps.state.mark(channel, built.dedupKey, Math.floor(Date.now() / 1000));
    return { sent: ok, reason: ok ? undefined : "送信に失敗しました" };
  }
}

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

export interface NotifyResult {
  sent: boolean;
  skipped?: boolean;
  disabled?: boolean;
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

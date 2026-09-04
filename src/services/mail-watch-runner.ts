/**
 * Gmail リアルタイム受信の常駐部 (spec/feature/mail-realtime.md)。
 *
 * 役割は 3 つだけ:
 *   1. Pub/Sub の StreamingPull 購読 (@ludiars/mail-watch) を起動・停止する
 *   2. 通知を受けたら MailIntakeService.syncFromHistory() を呼ぶ
 *      (通知内の historyId は順序保証が無いので基準にしない)
 *   3. users.watch の登録・解除と、 その状態の外出し (API と /health)
 *
 * 鍵・設定が欠けているときは例外にせず disabled として返し、 成功と区別する。
 * 常駐 gRPC が黙って切れるのが最大の運用リスクなので、 接続状態は必ず外から見えるようにする。
 */

import { MailWatchSubscriber, type MailWatchState } from "@ludiars/mail-watch";
import type { MailSource } from "@ludiars/mail-inbox";
import type { MailWatchStateRepo } from "../db/mail-watch-state-repo.js";
import type { MailRealtimeConfig, MailSyncResult } from "./mail-intake-service.js";

export interface MailWatchStatus {
  enabled: boolean;
  connected: boolean;
  history_id: string | null;
  watch_expires_at: number | null;
  last_notified_at: number | null;
  last_synced_at: number | null;
  received_count: number;
  reconnect_count: number;
  last_error: string | null;
  /** watch 期限まで 2 日を切った、 または最終受信から 24 時間以上経過 */
  stale: boolean;
  disabled?: true;
  reason?: string;
}

export interface MailWatchRenewResult {
  expires_at?: number;
  history_id?: string;
  disabled?: true;
  reason?: string;
}

export interface MailWatchSubscriberLike {
  start(): void;
  stop(): Promise<void>;
  readonly state: MailWatchState;
}

export interface MailWatchRunnerDeps {
  source?: MailSource;
  watchState: MailWatchStateRepo;
  config?: MailRealtimeConfig;
  sync: () => Promise<MailSyncResult>;
  /** サービスアカウント鍵 JSON (暗号化ストアの QUAESTOR_PUBSUB_SA_JSON)。 既定は env */
  serviceAccountJson?: string;
  /** テスト用の購読差し替え */
  createSubscriber?: (opts: {
    subscriptionName: string;
    credentials: { client_email: string; private_key: string };
    onNotification: () => Promise<void>;
    onError: (error: Error) => void;
  }) => MailWatchSubscriberLike;
  logger?: {
    warn(fields: Record<string, unknown>, message?: string): void;
    info?(fields: Record<string, unknown>, message?: string): void;
  };
  now?: () => number;
}

const DAY_SEC = 86_400;
const STALE_EXPIRY_SEC = 2 * DAY_SEC;
const STALE_SILENCE_SEC = DAY_SEC;

export class MailWatchRunner {
  private subscriber: MailWatchSubscriberLike | null = null;

  constructor(private readonly deps: MailWatchRunnerDeps) {}

  /**
   * 設定と鍵が揃っているときだけ購読を張る。 欠けていれば理由を返して何もしない。
   * @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md)
   */
  start(): { started: boolean; reason?: string } {
    if (this.subscriber) return { started: true };
    const reason = this.disabledReason();
    if (reason) return { started: false, reason };
    const credentials = this.credentials();
    if (!credentials) return { started: false, reason: "QUAESTOR_PUBSUB_SA_JSON is not configured" };

    const subscriptionName = this.deps.config?.subscriptionName;
    if (!subscriptionName) {
      return { started: false, reason: "mailIntake.realtime.subscriptionName is not configured" };
    }
    const create = this.deps.createSubscriber ?? defaultSubscriberFactory;
    const subscriber = create({
      subscriptionName,
      credentials,
      // 通知は syncFromHistory のトリガとしてのみ使う (通知内の historyId は信じない)。
      onNotification: async () => {
        this.deps.watchState.markNotified(this.now());
        await this.deps.sync();
      },
      onError: (error) => {
        this.deps.logger?.warn({ event: "mail_watch_error", error: error.name }, "mail watch subscriber error");
      },
    });
    subscriber.start();
    this.subscriber = subscriber;
    this.deps.logger?.info?.({ subscriptionName }, "mail watch subscriber started");
    return { started: true };
  }

  async stop(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = null;
    await subscriber?.stop();
  }

  /**
   * users.watch を張り直して期限と基準 historyId を保存する。
   * @implements SPEC-MAIL-REALTIME-005 (spec/feature/mail-realtime.md)
   */
  async renew(): Promise<MailWatchRenewResult> {
    const reason = this.disabledReason();
    if (reason) return { disabled: true, reason };
    const topicName = this.deps.config?.topicName;
    const source = this.deps.source;
    if (!topicName || !source) return { disabled: true, reason: "mail realtime is not configured" };
    const registration = await source.watch({
      topicName,
      labelIds: this.deps.config?.labelIds,
    });
    const expiresAt = Math.floor(registration.expiration.getTime() / 1000);
    this.deps.watchState.setWatch({ historyId: registration.historyId, expiresAt });
    return { expires_at: expiresAt, history_id: registration.historyId };
  }

  /** users.stop。 履歴の基準点は cron sweep と併用するため消さない。 */
  async stopWatch(): Promise<{ ok?: true; disabled?: true; reason?: string }> {
    const reason = this.disabledReason({ requireTopic: false });
    if (reason) return { disabled: true, reason };
    const source = this.deps.source;
    if (!source) return { disabled: true, reason: "QUAESTOR_GMAIL_* is not configured" };
    await source.stopWatch();
    this.deps.watchState.clearWatch();
    await this.stop();
    return { ok: true };
  }

  /** @implements SPEC-MAIL-REALTIME-006 (spec/feature/mail-realtime.md) */
  status(): MailWatchStatus {
    const row = this.deps.watchState.get();
    const state = this.subscriber?.state;
    const reason = this.disabledReason({ requireTopic: false });
    const base: MailWatchStatus = {
      enabled: !reason,
      connected: state?.connected ?? false,
      history_id: row?.history_id ?? null,
      watch_expires_at: row?.watch_expires_at ?? null,
      last_notified_at: row?.last_notified_at ?? null,
      last_synced_at: row?.last_synced_at ?? null,
      received_count: state?.receivedCount ?? 0,
      reconnect_count: state?.reconnectCount ?? 0,
      last_error: state?.lastError ?? null,
      stale: this.isStale(
        row?.watch_expires_at ?? null,
        row?.last_notified_at ?? null,
        row?.updated_at ?? null,
      ),
    };
    return reason ? { ...base, disabled: true, reason } : base;
  }

  /** 期限切れ間近・長時間の無通知はどちらも「無音で止まっている」形の事故になる。 */
  private isStale(
    expiresAt: number | null,
    lastNotifiedAt: number | null,
    updatedAt: number | null,
  ): boolean {
    if (this.disabledReason({ requireTopic: false })) return false;
    const now = this.now();
    if (expiresAt === null) return true;
    if (expiresAt - now < STALE_EXPIRY_SEC) return true;
    const lastActivityAt = lastNotifiedAt ?? updatedAt;
    return lastActivityAt !== null && now - lastActivityAt > STALE_SILENCE_SEC;
  }

  private disabledReason(opts: { requireTopic?: boolean } = {}): string | null {
    const config = this.deps.config;
    if (!config?.enabled) return "mailIntake.realtime.enabled=false";
    if (!this.deps.source) return "QUAESTOR_GMAIL_* is not configured";
    if (opts.requireTopic !== false && !config.topicName) return "mailIntake.realtime.topicName is not configured";
    if (!config.subscriptionName) return "mailIntake.realtime.subscriptionName is not configured";
    if (!this.credentials()) return "QUAESTOR_PUBSUB_SA_JSON is not configured";
    return null;
  }

  private credentials(): { client_email: string; private_key: string } | null {
    const raw = this.deps.serviceAccountJson ?? process.env.QUAESTOR_PUBSUB_SA_JSON;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
      const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : "";
      const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : "";
      if (!clientEmail || !privateKey) return null;
      return { client_email: clientEmail, private_key: privateKey };
    } catch {
      return null; // 壊れた鍵で例外を投げず、 未設定と同じ扱いにする
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }
}

function defaultSubscriberFactory(opts: {
  subscriptionName: string;
  credentials: { client_email: string; private_key: string };
  onNotification: () => Promise<void>;
  onError: (error: Error) => void;
}): MailWatchSubscriberLike {
  return new MailWatchSubscriber({
    subscriptionName: opts.subscriptionName,
    credentials: opts.credentials,
    onNotification: async () => { await opts.onNotification(); },
    onError: opts.onError,
  });
}

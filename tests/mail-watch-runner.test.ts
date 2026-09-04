import type { MailSource } from "@ludiars/mail-inbox";
import type { MailWatchState } from "@ludiars/mail-watch";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailWatchStateRepo } from "../src/db/mail-watch-state-repo.js";
import { applyMigrations } from "../src/db/schema.js";
import type { MailRealtimeConfig, MailSyncResult } from "../src/services/mail-intake-service.js";
import { MailWatchRunner, type MailWatchSubscriberLike } from "../src/services/mail-watch-runner.js";

const NOW = Math.floor(Date.parse("2026-09-04T00:00:00Z") / 1000);
const DAY = 86_400;
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@example.iam", private_key: "key" });

describe("MailWatchRunner", () => {
  let db: Database.Database;
  let watchState: MailWatchStateRepo;
  let sync: ReturnType<typeof vi.fn>;
  let subscriber: FakeSubscriber;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    watchState = new MailWatchStateRepo(db);
    sync = vi.fn(async () => ({ initialized: false } as unknown as MailSyncResult));
    subscriber = new FakeSubscriber();
  });

  afterEach(() => { db.close(); });

  it("does not start and explains why when the service account key is missing", () => {
    const runner = createRunner({ serviceAccountJson: undefined });

    expect(runner.start()).toEqual({
      started: false,
      reason: "QUAESTOR_PUBSUB_SA_JSON is not configured",
    });
    expect(runner.status()).toMatchObject({
      disabled: true,
      enabled: false,
      connected: false,
      reason: "QUAESTOR_PUBSUB_SA_JSON is not configured",
    });
  });

  it("reports realtime as disabled with a reason when the config is off", () => {
    const runner = createRunner({ config: { ...realtimeConfig(), enabled: false } });

    expect(runner.status()).toMatchObject({
      disabled: true,
      enabled: false,
      reason: "mailIntake.realtime.enabled=false",
      stale: false,
    });
  });

  it("treats a malformed service account key as unconfigured rather than throwing", () => {
    const runner = createRunner({ serviceAccountJson: "{ not json" });

    expect(runner.start().started).toBe(false);
  });

  it("triggers a history sync on notification without trusting the notification payload", async () => {
    const runner = createRunner();

    expect(runner.start()).toEqual({ started: true });
    await subscriber.emit();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(watchState.get()?.last_notified_at).toBe(NOW);
    expect(runner.status()).toMatchObject({ connected: true, received_count: 1 });
  });

  it("stores the watch expiry and baseline on renew", async () => {
    const source = fakeSource();
    const runner = createRunner({ source });

    expect(await runner.renew()).toEqual({
      expires_at: Math.floor(Date.parse("2026-09-11T00:00:00Z") / 1000),
      history_id: "1000",
    });
    expect(source.watch).toHaveBeenCalledWith({
      topicName: "projects/p/topics/t",
      labelIds: ["INBOX"],
    });
    expect(watchState.get()).toMatchObject({ history_id: "1000" });
  });

  it("marks the watch stale when the registration is close to expiring", () => {
    const runner = createRunner();
    watchState.setWatch({ historyId: "1000", expiresAt: NOW + 6 * DAY });
    expect(runner.status().stale).toBe(false);

    watchState.setWatch({ historyId: "1000", expiresAt: NOW + DAY });
    expect(runner.status().stale).toBe(true);
  });

  it("marks the watch stale after a day without notifications", () => {
    const runner = createRunner();
    watchState.setWatch({ historyId: "1000", expiresAt: NOW + 6 * DAY });
    watchState.markNotified(NOW - 2 * DAY);

    expect(runner.status().stale).toBe(true);
  });

  it("clears the expiry and stops the subscriber on watch stop", async () => {
    const source = fakeSource();
    const runner = createRunner({ source });
    runner.start();
    watchState.setWatch({ historyId: "1000", expiresAt: NOW + 6 * DAY });

    expect(await runner.stopWatch()).toEqual({ ok: true });
    expect(source.stopWatch).toHaveBeenCalledTimes(1);
    expect(watchState.get()?.watch_expires_at).toBeNull();
    expect(watchState.get()?.history_id).toBe("1000");
    expect(subscriber.stopped).toBe(true);
  });

  function createRunner(opts: {
    source?: MailSource;
    config?: MailRealtimeConfig;
    serviceAccountJson?: string;
  } = {}): MailWatchRunner {
    return new MailWatchRunner({
      source: opts.source ?? fakeSource(),
      watchState,
      config: opts.config ?? realtimeConfig(),
      sync: () => sync() as Promise<MailSyncResult>,
      serviceAccountJson: "serviceAccountJson" in opts ? opts.serviceAccountJson : SERVICE_ACCOUNT,
      createSubscriber: (subscriberOpts) => {
        subscriber.onNotification = subscriberOpts.onNotification;
        return subscriber;
      },
      now: () => NOW,
    });
  }
});

function realtimeConfig(): MailRealtimeConfig {
  return {
    enabled: true,
    topicName: "projects/p/topics/t",
    subscriptionName: "projects/p/subscriptions/s",
    labelIds: ["INBOX"],
    repoAllowlist: ["LUDIARS/*"],
  };
}

class FakeSubscriber implements MailWatchSubscriberLike {
  onNotification: (() => Promise<void>) | null = null;
  stopped = false;
  private started = false;
  private received = 0;

  start(): void { this.started = true; }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
  }

  async emit(): Promise<void> {
    this.received++;
    await this.onNotification?.();
  }

  get state(): MailWatchState {
    return {
      connected: this.started,
      lastMessageAt: null,
      lastError: null,
      receivedCount: this.received,
      reconnectCount: 0,
    };
  }
}

function fakeSource(): MailSource {
  return {
    search: vi.fn(async () => []),
    get: vi.fn(async () => null),
    loadAttachment: vi.fn(async () => Buffer.alloc(0)),
    history: vi.fn(async () => ({ changes: [], historyId: "1000", expired: false })),
    watch: vi.fn(async () => ({ historyId: "1000", expiration: new Date("2026-09-11T00:00:00Z") })),
    stopWatch: vi.fn(async () => { /* recorded by the spy */ }),
    currentHistoryId: vi.fn(async () => "1000"),
  };
}

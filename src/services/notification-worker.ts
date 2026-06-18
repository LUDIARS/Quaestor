/**
 * 定期 Discord 通知ワーカー。 一定間隔で自サーバの /v1/notify/* を dedup 付きで叩く。
 * dedup により「前回と同内容」のときは送信されない (NotificationService 側で判定)。
 *
 * NotificationService を直接持たず HTTP 経由にすることで、 server.ts が advisor 群を
 * 再構築せずに済む (buildApp が組んだ実体をそのまま使う)。
 */

interface MiniLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface NotificationWorkerOptions {
  baseUrl: string;          // 例 http://127.0.0.1:17400
  intervalMs: number;
  invest: boolean;
  portfolio: boolean;
  subsidies: { enabled: boolean; planId: string | null };
  fetchImpl?: typeof fetch;
  logger?: MiniLogger;
}

export class NotificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: NotificationWorkerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.timer) return;
    // 起動直後に 1 回 + 以降 interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    const jobs: { path: string; body: Record<string, unknown> }[] = [];
    if (this.opts.invest) jobs.push({ path: "/v1/notify/invest", body: { dedup: true } });
    if (this.opts.portfolio) jobs.push({ path: "/v1/notify/portfolio", body: { dedup: true } });
    if (this.opts.subsidies.enabled && this.opts.subsidies.planId) {
      jobs.push({ path: "/v1/notify/subsidies", body: { dedup: true, plan_id: this.opts.subsidies.planId } });
    }
    for (const job of jobs) {
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}${job.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(job.body),
        });
        const json = (await res.json().catch(() => ({}))) as { sent?: boolean; skipped?: boolean; disabled?: boolean };
        this.opts.logger?.info({ path: job.path, ...json }, "notification tick");
      } catch (e: unknown) {
        this.opts.logger?.warn({ path: job.path, err: e instanceof Error ? e.message : String(e) }, "notification tick failed");
      }
    }
  }
}

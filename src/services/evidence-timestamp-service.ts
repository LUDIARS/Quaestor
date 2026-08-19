/**
 * 合意証跡 (evidence_sha256) への外部タイムスタンプ付与。 合意確定時に 1 回同期で試し、
 * 失敗は `pending` のまま残して再試行ジョブが拾う。 タイムスタンプが取れなくても合意は成立する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-008 (spec/feature/invoice-public-magic-link.md)
 */

import type { InvoiceShareAcceptanceRepo, InvoiceShareAcceptanceRow } from "../db/invoice-share-acceptance-repo.js";
import { Rfc3161Error, type Rfc3161TimestampClient } from "./rfc3161-timestamp-client.js";

/** この日数を過ぎても取れない pending は failed で確定し、 再試行を止める。 */
const GIVE_UP_AFTER_SECONDS = 7 * 24 * 60 * 60;
const RETRY_BATCH = 50;

export interface EvidenceTimestampServiceOptions {
  acceptances: InvoiceShareAcceptanceRepo;
  /** undefined = タイムスタンプ無効 (status は skipped のまま)。 */
  client?: Rfc3161TimestampClient;
  now?: () => number;
  onError?: (acceptanceId: string, error: unknown) => void;
}

export class EvidenceTimestampService {
  private readonly now: () => number;

  constructor(private readonly options: EvidenceTimestampServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get enabled(): boolean {
    return this.options.client !== undefined;
  }

  get authorityUrl(): string | null {
    return this.options.client?.url ?? null;
  }

  /** 1 行ぶん試す。 granted なら true。 失敗は pending (または期限切れで failed) に更新して false。 */
  async attach(acceptance: InvoiceShareAcceptanceRow): Promise<boolean> {
    const client = this.options.client;
    if (!client || acceptance.timestamp_status === "granted" || acceptance.timestamp_status === "skipped") {
      return acceptance.timestamp_status === "granted";
    }
    const requestedAt = this.now();
    try {
      const token = await client.timestamp(acceptance.evidence_sha256);
      this.options.acceptances.updateTimestamp(acceptance.id, {
        status: "granted",
        token: token.response,
        requestedAt,
        grantedAt: requestedAt,
        lastError: null,
      });
      return true;
    } catch (error) {
      const gaveUp = requestedAt - acceptance.accepted_at > GIVE_UP_AFTER_SECONDS;
      this.options.acceptances.updateTimestamp(acceptance.id, {
        status: gaveUp ? "failed" : "pending",
        requestedAt,
        lastError: error instanceof Rfc3161Error ? error.code : "unknown",
      });
      this.options.onError?.(acceptance.id, error);
      return false;
    }
  }

  /** pending を古い順に最大 RETRY_BATCH 件再試行する。 起動時と定期実行から呼ぶ。 */
  async retryPending(): Promise<{ attempted: number; granted: number }> {
    if (!this.options.client) return { attempted: 0, granted: 0 };
    const pending = this.options.acceptances.listTimestampPending(RETRY_BATCH);
    let granted = 0;
    for (const row of pending) {
      if (await this.attach(row)) granted += 1;
    }
    return { attempted: pending.length, granted };
  }
}

/** 1 時間毎の再試行ループを張る。 返り値で止められる。 本番エントリポイントだけが呼ぶ。 */
export function startEvidenceTimestampRetryJob(
  service: EvidenceTimestampService,
  intervalMs = 60 * 60 * 1000,
): () => void {
  if (!service.enabled) return () => undefined;
  const run = () => { void service.retryPending().catch(() => undefined); };
  run();
  const handle = setInterval(run, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

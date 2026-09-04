/**
 * Gmail リアルタイム受信の基準点 (1 行のみ)。
 *
 * Pub/Sub 通知には順序保証が無いため、 差分取得の基準は通知内の historyId ではなく
 * この行の history_id とする (spec/feature/mail-realtime.md SPEC-MAIL-REALTIME-001)。
 */

import type Database from "better-sqlite3";

export interface MailWatchStateRow {
  id: 1;
  history_id: string | null;
  watch_expires_at: number | null;
  last_notified_at: number | null;
  last_synced_at: number | null;
  updated_at: number;
}

export class MailWatchStateRepo {
  constructor(private readonly db: Database.Database) {}

  /** @implements SPEC-MAIL-REALTIME-001 (spec/feature/mail-realtime.md) */
  get(): MailWatchStateRow | undefined {
    return this.db.prepare("SELECT * FROM mail_watch_state WHERE id = 1").get() as
      MailWatchStateRow | undefined;
  }

  /** 差分取得の基準点を進める。 同期時刻も併せて記録する。 */
  /** @implements SPEC-MAIL-REALTIME-001 (spec/feature/mail-realtime.md) */
  setHistoryId(historyId: string, syncedAt = nowSec()): void {
    this.upsert({ history_id: historyId, last_synced_at: syncedAt });
  }

  /** users.watch の登録結果 (期限と基準 historyId) を保存する。 */
  /** @implements SPEC-MAIL-REALTIME-006 (spec/feature/mail-realtime.md) */
  setWatch(input: { historyId: string; expiresAt: number }): void {
    this.upsert({ history_id: input.historyId, watch_expires_at: input.expiresAt });
  }

  /** users.stop 後は期限だけ落とす (history_id は sweep 併用のため残す)。 */
  clearWatch(): void {
    this.upsert({ watch_expires_at: null });
  }

  /** Pub/Sub 通知を受け取った時刻。 subscriber の生存確認に使う。 */
  /** @implements SPEC-MAIL-REALTIME-006 (spec/feature/mail-realtime.md) */
  markNotified(at = nowSec()): void {
    this.upsert({ last_notified_at: at });
  }

  private upsert(patch: Partial<Omit<MailWatchStateRow, "id" | "updated_at">>): void {
    const current = this.get();
    const next: Omit<MailWatchStateRow, "id"> = {
      history_id: current?.history_id ?? null,
      watch_expires_at: current?.watch_expires_at ?? null,
      last_notified_at: current?.last_notified_at ?? null,
      last_synced_at: current?.last_synced_at ?? null,
      ...patch,
      updated_at: nowSec(),
    };
    this.db.prepare(
      `INSERT INTO mail_watch_state
         (id, history_id, watch_expires_at, last_notified_at, last_synced_at, updated_at)
       VALUES (1, @history_id, @watch_expires_at, @last_notified_at, @last_synced_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         history_id = excluded.history_id,
         watch_expires_at = excluded.watch_expires_at,
         last_notified_at = excluded.last_notified_at,
         last_synced_at = excluded.last_synced_at,
         updated_at = excluded.updated_at`,
    ).run(next);
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

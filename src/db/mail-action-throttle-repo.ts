/**
 * 検知後の delegation 起動を debounce するための記録。
 *
 * Concordia 側にキュー (admin.delegation_max_concurrency) はあるが、 キューは実行を直列化する
 * だけで投げた分は必ずいつか走る。 壊れたワークフロー 1 本で委託枠を塞がないよう、
 * 起動判断そのものを Quaestor 側で絞る (spec/feature/mail-realtime.md)。
 *
 * key の形で役割を分ける:
 *   ci_failure:sha:<repo>:<workflow>:<head_sha>  一度でも起動したら二度と起動しない印
 *   ci_failure:rate:<repo>:<workflow>            6 時間に 1 回 / 1 日 3 回
 *   dependabot:<repo>                            24 時間に 1 回
 */

import type Database from "better-sqlite3";

export interface MailActionThrottleRow {
  key: string;
  last_fired_at: number;
  fired_today: number;
  /** YYYY-MM-DD (JST)。 日が変わったら fired_today は 0 とみなす。 */
  day: string;
}

export class MailActionThrottleRepo {
  constructor(private readonly db: Database.Database) {}

  /** @implements SPEC-MAIL-REALTIME-004 (spec/feature/mail-realtime.md) */
  get(key: string): MailActionThrottleRow | undefined {
    return this.db.prepare("SELECT * FROM mail_action_throttle WHERE key = ?").get(key) as
      MailActionThrottleRow | undefined;
  }

  /** 当日の起動回数。 記録が別の日なら 0 (日付が変わればリセットされる)。 */
  /** @implements SPEC-MAIL-REALTIME-004 (spec/feature/mail-realtime.md) */
  firedToday(key: string, day: string): number {
    const row = this.get(key);
    if (!row || row.day !== day) return 0;
    return row.fired_today;
  }

  /** 起動を記録する。 日が変わっていれば当日カウントを 1 から数え直す。 */
  /** @implements SPEC-MAIL-REALTIME-004 (spec/feature/mail-realtime.md) */
  record(key: string, firedAt: number, day: string): MailActionThrottleRow {
    const next = this.firedToday(key, day) + 1;
    this.db.prepare(
      `INSERT INTO mail_action_throttle (key, last_fired_at, fired_today, day)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         last_fired_at = excluded.last_fired_at,
         fired_today = excluded.fired_today,
         day = excluded.day`,
    ).run(key, firedAt, next, day);
    return { key, last_fired_at: firedAt, fired_today: next, day };
  }
}

/**
 * 定期通知の重複抑止用の軽量 state (channel ごとの最終送信 dedupKey)。
 * DB を汚さないよう JSON ファイル 1 枚で持つ (window-title state と同流儀)。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

type StateShape = Record<string, { key: string; sent_at: number }>;

export class NotificationState {
  constructor(private readonly path: string) {}

  private read(): StateShape {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")) as StateShape; } catch { return {}; }
  }

  private write(s: StateShape): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(s, null, 2), "utf8");
  }

  /** channel の最終送信 key と一致するか (= 前回と同内容で再送不要) */
  isSame(channel: string, key: string): boolean {
    return this.read()[channel]?.key === key;
  }

  /** 送信済みとして記録 */
  mark(channel: string, key: string, now: number): void {
    const s = this.read();
    s[channel] = { key, sent_at: now };
    this.write(s);
  }
}

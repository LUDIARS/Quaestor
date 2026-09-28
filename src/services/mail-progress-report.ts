import { z } from "zod";

export const MailProgressSchema = z.object({
  ready: z.boolean(), running: z.boolean(), pending: z.number().int().nonnegative(),
  nextAt: z.number(), lastError: z.string().nullable(),
  backfill: z.object({ requestId: z.string(), target: z.number().nullable(),
    processed: z.number().int().nonnegative(), status: z.enum(["active", "completed", "exhausted"]) }),
});
export type MailProgress = z.infer<typeof MailProgressSchema>;
export interface ReportCheckpoint { sentAt: number; status: string; error: string | null }
export const MAIL_REPORT_INTERVAL_MS = 600_000;

/** @implements SPEC-MAIL-CRAWLER-006 */
export function shouldReportMail(progress: MailProgress, previous: ReportCheckpoint | null, now: number): boolean {
  return !previous || previous.status !== progress.backfill.status || previous.error !== progress.lastError
    || (progress.backfill.status === "active" && now - previous.sentAt >= MAIL_REPORT_INTERVAL_MS);
}

/** Content is deliberately limited to counts and safe diagnostics. */
export function formatMailProgress(progress: MailProgress): string {
  const job = progress.backfill;
  const phase = job.status === "exhausted" ? "対象範囲の探索完了" : job.status === "completed" ? "指定件数の処理完了"
    : progress.lastError ? "再試行待ち" : progress.running ? "処理中" : "次回処理待ち";
  const count = job.target === null ? `${job.processed}件処理済み（全件探索・総数未確定）` : `${job.processed}／${job.target}件処理済み`;
  const error = progress.lastError && /^[a-zA-Z0-9_]{1,100}$/.test(progress.lastError) ? progress.lastError : progress.lastError ? "取得エラー" : "なし";
  return `メール解析の進捗：${phase}\n${count}\n取得済み待機：${progress.pending}件（全体の残件数ではありません）\nエラー：${error}`;
}

import { describe, expect, it } from "vitest";
import { shouldReportMail, formatMailProgress, type MailProgress } from "../src/services/mail-progress-report.js";

const progress: MailProgress = { ready: true, running: true, pending: 4, nextAt: 1000, lastError: null,
  backfill: { requestId: "reporting-test", target: null, processed: 510, status: "active" } };
describe("mail progress reporting", () => {
  it("reports initially, at ten minutes, and immediately on completion or errors", () => {
    const previous = { sentAt: 100, status: "active", error: null };
    expect(shouldReportMail(progress, null, 100)).toBe(true);
    expect(shouldReportMail(progress, previous, 600_099)).toBe(false);
    expect(shouldReportMail(progress, previous, 600_100)).toBe(true);
    expect(shouldReportMail({ ...progress, lastError: "mail_luna_timeout" }, previous, 101)).toBe(true);
    expect(shouldReportMail({ ...progress, backfill: { ...progress.backfill, status: "exhausted" } }, previous, 101)).toBe(true);
  });
  it("does not call discovered pending IDs the total remaining and suppresses unsafe diagnostics", () => {
    const text = formatMailProgress({ ...progress, lastError: "private@example.test secret text" });
    expect(text).toContain("510件"); expect(text).toContain("総数未確定");
    expect(text).toContain("全体の残件数ではありません"); expect(text).not.toContain("private@");
  });
  it("does not repeat a final report after restart with the saved checkpoint", () => {
    const finished = { ...progress, backfill: { ...progress.backfill, status: "exhausted" as const } };
    expect(shouldReportMail(finished, { sentAt: 1, status: "exhausted", error: null }, 1_000_000)).toBe(false);
  });
});

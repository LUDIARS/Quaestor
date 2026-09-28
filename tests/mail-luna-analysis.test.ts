import Database from "better-sqlite3";
import type { MailMessage } from "@ludiars/mail-inbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../src/db/schema.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { MailAnalysisRepo } from "../src/db/mail-analysis-repo.js";
import { MailIgnoreEngine } from "../src/services/mail-ignore-engine.js";
import { MailCrawlAnalysis } from "../src/services/mail-crawl-analysis.js";
import { MailLunaAnalysis, type MailAnalysis } from "../src/services/mail-luna-analysis.js";

function message(id: string): MailMessage {
  return { id, threadId: "thread", from: { address: "news@example.test" }, to: [],
    subject: "Weekly digest 123", date: new Date("2026-09-01T00:00:00Z"),
    text: "Hello reader\n\nStories\n\nRead more", html: "<html><body><h1>Digest</h1><p>Stories</p></body></html>",
    snippet: "", labelIds: [], attachments: [], headers: {} };
}
describe("Luna mail analysis", () => {
  let db: Database.Database;
  let messages: MailMessagesRepo;
  let engine: MailIgnoreEngine;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); messages = new MailMessagesRepo(db); engine = new MailIgnoreEngine(db); });
  afterEach(() => db.close());
  it("learns a guarded rule from one analyzed mail and skips Luna for the next matching mail", async () => {
    const analyze = vi.fn(async (): Promise<MailAnalysis> => ({ kind: "ignore", confidence: 0.98 }));
    const pipeline = new MailCrawlAnalysis(db, { analyze }, messages, engine, []);
    await Promise.all([pipeline.handle(message("a")), pipeline.handle(message("a"))]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(engine.stats().activeRules).toBe(1);
    expect(messages.find("a")?.outcome).toBe("ignored: luna");
    expect(await pipeline.handle(message("b"))).toBe(false);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.prepare("SELECT * FROM mail_luna_analysis").all())).not.toContain("Hello reader");
  });
  it("retains protection and retirement, and caches a result across reconstruction", async () => {
    const analyze = vi.fn(async (): Promise<MailAnalysis> => ({ kind: "ignore", confidence: 0.99 }));
    const pipeline = new MailCrawlAnalysis(db, { analyze }, messages, engine, []);
    await pipeline.handle({ ...message("invoice"), subject: "Invoice" });
    expect(messages.find("invoice")?.outcome).toBe("analysis_review: ignore");
    expect(engine.stats().activeRules).toBe(0);
    await pipeline.handle(message("first")); engine.retire(engine.rules()[0]!.id);
    await pipeline.handle(message("second"));
    expect(engine.stats().activeRules).toBe(0);
    new MailAnalysisRepo(db).save("cached", { kind: "review", confidence: 0.3 });
    const count = analyze.mock.calls.length;
    await new MailCrawlAnalysis(db, { analyze }, messages, engine, []).handle(message("cached"));
    expect(analyze).toHaveBeenCalledTimes(count);
    expect(messages.find("cached")?.outcome).toBe("analysis_review: review");
  });
  it("keeps uncertain and actionable results out of rule learning", async () => {
    for (const result of [{ kind: "ignore", confidence: 0.5 }, { kind: "invoice", confidence: 1 }] as MailAnalysis[]) {
      await new MailCrawlAnalysis(db, { analyze: async () => result }, messages, engine, []).handle(message(result.kind));
    }
    expect(engine.stats().observed).toBe(0);
    expect(messages.list().every((row) => row.outcome.startsWith("analysis_review:"))).toBe(true);
  });
  it("bounds transmitted data and excludes attachment bytes", async () => {
    const run = vi.fn(async (_prompt: string, _schema: object) => ({ kind: "review", confidence: 0.5 }));
    await new MailLunaAnalysis(run).analyze({ ...message("wire"), text: "x".repeat(30_000),
      attachments: [{ filename: "doc.pdf", mimeType: "application/pdf", size: 6, attachmentId: "secret-id", data: Buffer.from("SECRET") }] });
    const prompt = run.mock.calls[0]![0];
    const input = JSON.parse(prompt.split("EMAIL_DATA_JSON:\n")[1]!);
    expect(input.text).toHaveLength(24_000);
    expect(input.truncated).toBe(true);
    expect(prompt).not.toContain("SECRET"); expect(prompt).not.toContain("secret-id");
    expect(run.mock.calls[0]![1]).toMatchObject({ additionalProperties: false, required: ["kind", "confidence"] });
  });
  it("preserves runner failures and rejects invalid classification", async () => {
    const error = Object.assign(new Error("unavailable"), { code: "mail_luna_cli_missing" });
    await expect(new MailLunaAnalysis(async () => { throw error; }).analyze(message("none"))).rejects.toBe(error);
    await expect(new MailLunaAnalysis(async () => ({ kind: "ignore", confidence: 5 })).analyze(message("bad")))
      .rejects.toMatchObject({ code: "mail_luna_invalid_result" });
  });
});

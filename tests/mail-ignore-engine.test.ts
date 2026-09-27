import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage, MailSource } from "@ludiars/mail-inbox";
import { applyMigrations } from "../src/db/schema.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { MailIgnoreEngine } from "../src/services/mail-ignore-engine.js";
import { bootstrapIgnorePatterns } from "../src/services/mail-ignore-bootstrap.js";
import { ignoreFeatures } from "../src/mail/ignore-features.js";
import { classifyMail } from "../src/mail/classify.js";
import { MailIgnoreGroupsRepo } from "../src/db/mail-ignore-groups-repo.js";

function message(id: string): MailMessage {
  return { id, threadId: "thread", from: { address: "news@example.test" }, to: [],
    subject: "Weekly digest 123", date: new Date("2026-09-01T00:00:00Z"),
    text: "Hello reader\n\nThis week's stories\n\nRead more", html: "<html><body><h1>Digest</h1><p>Stories</p></body></html>",
    snippet: "", labelIds: ["INBOX"], attachments: [], headers: {} };
}

describe("non-LLM bulk-ignore rules", () => {
  let db: Database.Database;
  let engine: MailIgnoreEngine;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); engine = new MailIgnoreEngine(db); });
  afterEach(() => { db.close(); });

  it("explicitly activates observed eligible templates once, without reviving retired rules", () => {
    engine.observe(message("one"));
    engine.observe({ ...message("protected"), subject: "Your invoice" });
    expect(engine.activateObserved()).toEqual({ created: 1, activeRules: 1 });
    expect(engine.activateObserved().created).toBe(0);
    engine.retire(engine.rules()[0]!.id);
    expect(engine.activateObserved()).toEqual({ created: 0, activeRules: 0 });
    expect(engine.stats().minimumMessages).toBe(5);
  });

  it("groups across history pages and keeps unprofiled and protected mail separate", () => {
    const repo = new MailMessagesRepo(db);
    for (let i = 0; i < 62; i++) {
      repo.claim({ message_id: String(i), thread_id: null, from_address: "news@example.test",
        subject: "Weekly digest", received_at: i, processed_at: 100, kind: "ignore",
        outcome: "ignored", rule_index: null, error: null });
      if (i < 60) engine.observe(message(String(i)));
      if (i === 60) engine.observe({ ...message(String(i)), subject: "Your invoice" });
    }
    const groups = new MailIgnoreGroupsRepo(db);
    const rows = groups.list(0);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ count: 60, state: "auto" });
    expect(groups.messages(rows[0]!.id, 0)).toHaveLength(51);
    expect(groups.messages(rows[0]!.id, 50)).toHaveLength(10);
    expect(rows.slice(1).map((row) => row.state).sort()).toEqual(["ineligible", "unprofiled"]);
    engine.retire(rows[0]!.ruleId!);
    expect(groups.list(0)[0]!.state).toBe("retired");
    expect(repo.list(undefined, 100)).toHaveLength(62);
  });

  it("requires five distinct messages and all three common features; stores no body text", () => {
    for (let i = 0; i < 10; i++) engine.observe(message("same"));
    expect(engine.stats().activeRules).toBe(0);
    for (let i = 0; i < 4; i++) engine.observe(message(String(i)));
    expect(engine.stats()).toMatchObject({ observed: 5, eligible: 5, activeRules: 1 });
    const next = { ...message("new"), subject: "Weekly digest 456" };
    expect(engine.match(next, false)).toBeTruthy();
    expect(engine.match({ ...next, from: { address: "other@example.test" } }, false)).toBeNull();
    expect(engine.match({ ...next, subject: "A different topic 456" }, false)).toBeNull();
    expect(engine.match({ ...next, html: "<html><body><table><tr><td>Stories</td></tr></table></body></html>" }, false)).toBeNull();
    const stored = JSON.stringify(db.prepare("SELECT * FROM mail_ignore_evidence").all());
    expect(stored).not.toContain("news@example.test");
    expect(stored).not.toContain("Weekly digest");
    expect(stored).not.toContain("Stories");
    expect(new MailIgnoreEngine(db).match(next, true)).toBeTruthy();
    const ledger = db.prepare("SELECT * FROM blackbox_decisions WHERE domain = 'mail.bulk-ignore'").all();
    expect(ledger).toHaveLength(1);
    expect(JSON.stringify(ledger)).not.toContain("Stories");
  });

  it("does not auto-exclude protected content, attachments, empty or oversized bodies", () => {
    const base = message("a");
    expect(ignoreFeatures({ ...base, html: '<div style="border:0"><p>Stories</p></div>' })).not.toBeNull();
    for (const changed of [
      { ...base, subject: "Your invoice" }, { ...base, text: "お支払い確認" },
      { ...base, html: "<p>Password reset</p>" }, { ...base, text: "x".repeat(128001) },
      { ...base, html: undefined, text: "" },
      { ...base, attachments: [{ filename: "file.pdf", attachmentId: "a", size: 1, mimeType: "application/pdf" }] },
    ]) expect(ignoreFeatures(changed)).toBeNull();
  });

  it("preserves retirement and existing positive classification precedence", () => {
    for (let i = 0; i < 5; i++) engine.observe(message(String(i)));
    const rule = engine.rules()[0]!;
    expect(engine.retire(rule.id)).toBe(true);
    engine.observe(message("six"));
    expect(engine.match(message("seven"), true)).toBeNull();
    expect(engine.stats()).toMatchObject({ activeRules: 0, retiredRules: 1 });
    expect(classifyMail(message("eight"), [{ kind: "cloud_notice", fromDomains: ["example.test"] }]).kind).toBe("cloud_notice");
  });

  it("backfills only completed ignores once without replaying history or downloading attachments", async () => {
    const repo = new MailMessagesRepo(db);
    for (let i = 0; i < 5; i++) repo.claim({ message_id: String(i), thread_id: null,
      from_address: "news@example.test", subject: "Weekly digest", received_at: 1, processed_at: 2,
      kind: "ignore", outcome: "ignored", rule_index: null, error: null });
    const before = repo.list();
    const get = vi.fn(async (id: string) => message(id));
    const source = { get } as unknown as MailSource;
    expect(await bootstrapIgnorePatterns(source, repo, engine, [], 100)).toEqual({ fetched: 5, observed: 5, skipped: 0, errors: 0 });
    expect(await bootstrapIgnorePatterns(source, repo, engine, [], 100)).toEqual({ fetched: 0, observed: 0, skipped: 0, errors: 0 });
    expect(get).toHaveBeenCalledTimes(5);
    expect(get.mock.calls[0]).toEqual([expect.any(String), { loadAttachments: false }]);
    expect(repo.list()).toEqual(before);
    expect(engine.stats().activeRules).toBe(1);
  });
});

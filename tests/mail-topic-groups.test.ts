import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailTopic } from "../src/mail/topic-groups.js";
import { applyMigrations } from "../src/db/schema.js";
import { MailMessagesRepo, type MailKind } from "../src/db/mail-messages-repo.js";
import { MailIgnoreEngine } from "../src/services/mail-ignore-engine.js";
import { MailIgnoreGroupsRepo } from "../src/db/mail-ignore-groups-repo.js";
import { mailHistoryRouter } from "../src/api/mail-history.js";

describe("deterministic notification groups", () => {
  let db: Database.Database;
  let messages: MailMessagesRepo;
  let groups: MailIgnoreGroupsRepo;
  beforeEach(() => {
    db = new Database(":memory:"); applyMigrations(db); messages = new MailMessagesRepo(db);
    new MailIgnoreEngine(db); groups = new MailIgnoreGroupsRepo(db);
  });
  afterEach(() => db.close());
  function add(id: string, sender: string, subject: string, kind: MailKind = "ignore", outcome = "ignored") {
    messages.claim({ message_id: id, from_address: sender, subject, kind, outcome, error: null,
      received_at: 100, processed_at: 110, thread_id: null, rule_index: null });
  }
  it("groups repository notifications across replies, templates and classifications, without changing outcomes", async () => {
    add("a", "notifications@github.com", "[YahataTakuto/SS] A pull request", "ignore", "analysis_review: review");
    add("b", "notifications@github.com", "Re: [yahat atakuto/SS] unrelated");
    add("c", "noreply@github.com", "Fwd: Re: [YahataTakuto/SS] Run failed: build", "ci_failure", "notified");
    add("d", "notifications@github.com", "[Other/SS] Another repository");
    const before = messages.list();
    const id = mailTopic("notifications@github.com", "[YahataTakuto/SS] test")!.id;
    const group = groups.list(0).find((row) => row.id === id)!;
    expect(group).toMatchObject({ count: 2, state: "topic", ruleId: null });
    expect(groups.messages(id, 0).map((row) => row.message_id).sort()).toEqual(["a", "c"]);
    const app = new Hono().route("/v1/mail-history", mailHistoryRouter(messages, undefined, () => true, groups));
    const response = await app.request(`/v1/mail-history?group=${id}&kind=ci_failure`);
    expect(response.status).toBe(200);
    expect((await response.json()).items.map((row: { message_id: string }) => row.message_id)).toEqual(["c"]);
    expect(messages.list()).toEqual(before);
    expect(new MailIgnoreEngine(db).stats().activeRules).toBe(0);
  });
  it("unifies V Point partner subjects and dedicated sender mail without hiding review outcomes", () => {
    add("a", "mytc@tsite.jp", "今週のおすすめ");
    add("b", "mail@contact.vpass.ne.jp", "Ｖポイントのご案内", "ignore", "analysis_review: review");
    add("c", "smbc_info@msg.smbc.co.jp", "Vポイント特典", "invoice", "needs_review");
    add("d", "other@example.test", "無関係なポイントの案内");
    const group = groups.list(0).find((row) => row.subject === "Vポイント")!;
    expect(group.count).toBe(3);
    expect(groups.messages(group.id, 0)).toHaveLength(3);
    expect(groups.messages(group.id, 0, 51, "invoice")).toHaveLength(1);
  });
  it("uses stable keys, rejects GitHub lookalike domains and keeps repo owners separate", () => {
    const a = mailTopic("notifications@github.com", "[YahataTakuto/SS] one");
    expect(mailTopic("noreply@github.com", "RE: [yahat atakuto/SS] bad")?.id).not.toBe(a?.id);
    expect(mailTopic("notifications@github.com", "Re: [YAHATATAKUTO/ss] two")?.id).toBe(a?.id);
    expect(mailTopic("notifications@github.com.evil.test", "[YahataTakuto/SS] one")?.id).not.toBe(a?.id);
    expect(mailTopic("notifications@github.com", "[another/SS] one")?.id).not.toBe(a?.id);
  });
  it("regroups other senders without fragmenting subjects or mixing different people", () => {
    add("a", "sender@example.test", "One subject", "ignore", "analysis_review: review");
    add("b", "sender@example.test", "Different template", "invoice", "needs_review");
    add("c", "other@example.test", "One subject");
    const rows = groups.list(0);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.sender === "sender@example.test")?.count).toBe(2);
  });
  it("paginates a topic across the whole stored history", () => {
    for (let i = 0; i < 60; i++) add(String(i), "mytc@tsite.jp", `お知らせ ${i}`);
    const group = groups.list(0)[0]!;
    expect(group.count).toBe(60);
    expect(groups.messages(group.id, 0, 50)).toHaveLength(50);
    expect(groups.messages(group.id, 50, 50)).toHaveLength(10);
  });
});

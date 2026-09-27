import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/schema.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { mailHistoryRouter } from "../src/api/mail-history.js";

describe("read-only mail analysis history", () => {
  let db: Database.Database;
  let repo: MailMessagesRepo;
  let app: Hono;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new MailMessagesRepo(db);
    for (let index = 0; index < 52; index++) repo.claim({
      message_id: `message-${String(index).padStart(3, "0")}`, thread_id: null,
      received_at: 1000, processed_at: 1100, from_address: "sender@example.test",
      subject: "<script>text only</script>", kind: index === 0 ? "invoice" : "ignore",
      rule_index: null, outcome: index === 0 ? "needs_review" : "ignored", error: null,
    });
    app = new Hono().route("/v1/mail-history", mailHistoryRouter(repo, "https://qs.example.test", () => false));
  });
  afterEach(() => db.close());
  it("paginates ignored and reviewed records deterministically without changing their history", async () => {
    const before = repo.list(undefined, 100);
    const response = await app.request("http://qs.example.test/v1/mail-history");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json();
    const second = await (await app.request("http://qs.example.test/v1/mail-history?offset=50")).json();
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((row) => row.message_id)).size).toBe(52);
    const filtered = await (await app.request("http://qs.example.test/v1/mail-history?kind=invoice")).json();
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].outcome).toBe("needs_review");
    expect(repo.list(undefined, 100)).toEqual(before);
  });
  it("rejects untrusted hosts, cross-site reads, Viewer, invalid queries and writes", async () => {
    expect((await app.request("http://evil.test/v1/mail-history", { headers: { "X-Forwarded-Host": "qs.example.test" } })).status).toBe(403);
    for (const headers of [{ Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }, { "X-Forwarded-Prefix": "/viewer" }]) {
      expect((await app.request("http://qs.example.test/v1/mail-history", { headers })).status).toBe(403);
    }
    expect((await app.request("http://qs.example.test/v1/mail-history?offset=-1")).status).toBe(400);
    expect((await app.request("http://qs.example.test/v1/mail-history?kind=invalid")).status).toBe(400);
    expect((await app.request("http://qs.example.test/v1/mail-history", { method: "POST" })).status).toBe(404);
    const noPublic = new Hono().route("/v1/mail-history", mailHistoryRouter(repo, undefined, () => false));
    expect((await noPublic.request("http://qs.example.test/v1/mail-history")).status).toBe(403);
  });
});

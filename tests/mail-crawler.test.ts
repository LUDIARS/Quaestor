import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSource } from "@ludiars/mail-inbox";
import { applyMigrations } from "../src/db/schema.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { MailCrawlStateRepo } from "../src/db/mail-crawl-state-repo.js";
import { MailCrawler } from "../src/services/mail-crawler.js";
import { GmailRateLimit, checkGmailLimit } from "../src/services/gmail-rate-limit.js";
import type { MailIdSource } from "../src/services/gmail-crawl-source.js";
import { gmailPacedFetch } from "../src/services/gmail-paced-fetch.js";

describe("incremental mail crawler", () => {
  let db: Database.Database;
  let messages: MailMessagesRepo;
  let state: MailCrawlStateRepo;
  let time: number;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); messages = new MailMessagesRepo(db);
    state = new MailCrawlStateRepo(db); time = 100_000; });
  afterEach(() => db.close());
  function claim(id: string) {
    messages.claim({ message_id: id, thread_id: null, from_address: "a@example.test", subject: "digest",
      received_at: 1, processed_at: 1, kind: "ignore", outcome: "ignored", rule_index: null, error: null });
  }
  function create(listIds: MailIdSource["listIds"], process = vi.fn(async (id: string) => { claim(id); return true; })) {
    return { process, crawler: new MailCrawler({ source: { listIds } as MailSource & MailIdSource,
      messages, state, query: "in:inbox", ready: () => true, process, now: () => time }) };
  }
  it("processes multiple ten-ID pages in one minute, stopping before known mail without fetching it", async () => {
    claim("known");
    const list = vi.fn().mockResolvedValueOnce({ ids: Array.from({ length: 10 }, (_, i) => `a${i}`), nextPageToken: "p2" })
      .mockResolvedValueOnce({ ids: ["new", "known", "older"], nextPageToken: "p3" });
    const { crawler, process } = create(list);
    await Promise.all([crawler.tick(), crawler.tick()]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenCalledTimes(11);
    expect(process).not.toHaveBeenCalledWith("known");
    expect(process).not.toHaveBeenCalledWith("older");
    expect(crawler.status()).toMatchObject({ processed: 11, nextAt: 160_000 });
    await crawler.tick(); expect(list).toHaveBeenCalledTimes(2);
  });
  it("persists partial progress and retries pending IDs after provider cooldown, including restart", async () => {
    const list = vi.fn().mockResolvedValue({ ids: ["a", "b", "c"], nextPageToken: null });
    const process = vi.fn(async (id: string) => {
      if (id === "b") throw new GmailRateLimit(time + 300_000, 429, "userRateLimitExceeded");
      claim(id); return true;
    });
    const { crawler } = create(list, process);
    await crawler.tick();
    expect(state.load("in:inbox").pending).toEqual(["b", "c"]);
    expect(crawler.status().nextAt).toBe(400_000);
    const resumed = create(list);
    time = 399_999; await resumed.crawler.tick(); expect(resumed.process).not.toHaveBeenCalled();
    time = 400_000; await resumed.crawler.tick();
    expect(resumed.process.mock.calls.map(([id]) => id)).toEqual(["b", "c"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(resumed.crawler.status().processed).toBe(3);
  });
  it("keeps the rest of a page when the time window ends", async () => {
    const list = vi.fn().mockResolvedValue({ ids: ["a", "b"], nextPageToken: null });
    const process = vi.fn(async (id: string) => { claim(id); time += 61_000; return true; });
    const { crawler } = create(list, process);
    await crawler.tick(); expect(state.load("in:inbox").pending).toEqual(["b"]);
    time = 161_000; await crawler.tick(); expect(state.load("in:inbox").pending).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("backfills exactly 500 unseen messages beyond known mail and makes the request idempotent", async () => {
    claim("known");
    const list = vi.fn(async (_query: string, token: string | null) => {
      const page = Number(token ?? 0);
      return { ids: ["known", ...Array.from({ length: 9 }, (_, i) => `old-${page * 9 + i}`)], nextPageToken: String(page + 1) };
    });
    const { crawler, process } = create(list);
    crawler.startBackfill("test-backfill-500", 500);
    await crawler.tick();
    expect(process).toHaveBeenCalledTimes(500);
    expect(process).not.toHaveBeenCalledWith("known");
    expect(crawler.status().backfill).toMatchObject({ target: 500, processed: 500, status: "completed" });
    expect(crawler.startBackfill("test-backfill-500", 500).backfill?.status).toBe("completed");
    expect(() => crawler.startBackfill("test-backfill-500", 499)).toThrow("backfill_request_conflict");
  });
  it("retains a backfill across restart and provider cooldown, then reports exhaustion", async () => {
    const list = vi.fn().mockResolvedValue({ ids: ["a", "b"], nextPageToken: null });
    const first = create(list, vi.fn(async (id: string) => {
      if (id === "b") throw new GmailRateLimit(time + 300_000, 429, "userRateLimitExceeded");
      claim(id); return true;
    }));
    first.crawler.startBackfill("resume-backfill", 500);
    await first.crawler.tick();
    expect(() => first.crawler.startBackfill("different-request", 500)).toThrow("crawler_busy");
    const resumed = create(list);
    time = 399_999; await resumed.crawler.tick(); expect(resumed.process).not.toHaveBeenCalled();
    time = 400_000; await resumed.crawler.tick();
    expect(resumed.process.mock.calls.map(([id]) => id)).toEqual(["b"]);
    expect(resumed.crawler.status().backfill).toMatchObject({ processed: 2, status: "exhausted" });
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("continues past 500 until exhaustion for an explicitly unbounded request", async () => {
    const list = vi.fn(async (_query: string, token: string | null) => {
      const page = Number(token ?? 0);
      return { ids: Array.from({ length: 10 }, (_, i) => `all-${page * 10 + i}`), nextPageToken: page < 50 ? String(page + 1) : null };
    });
    const { crawler, process } = create(list);
    crawler.startBackfill("all-year-2026", null);
    await crawler.tick();
    expect(process).toHaveBeenCalledTimes(510);
    expect(crawler.status().backfill).toMatchObject({ target: null, processed: 510, status: "exhausted" });
    expect(crawler.startBackfill("all-year-2026", null).backfill?.status).toBe("exhausted");
    expect(() => crawler.startBackfill("all-year-2026", 500)).toThrow("backfill_request_conflict");
  });
  it("honors retry-after and never retains raw provider text", async () => {
    const response = new Response(JSON.stringify({ error: { message: "private payload", errors: [{ reason: "userRateLimitExceeded" }] } }),
      { status: 403, headers: { "Retry-After": "300" } });
    await expect(checkGmailLimit(response, time)).rejects.toMatchObject({ retryAt: 400_000, status: 403, reason: "userRateLimitExceeded" });
  });
  it("enforces a rolling budget across callers without issuing the over-budget request", async () => {
    const upstream = vi.fn(async () => new Response("{}"));
    const fetcher = gmailPacedFetch(upstream as typeof fetch, async () => {}, () => time);
    for (let i = 0; i < 270; i++) await fetcher("https://gmail.googleapis.com/gmail/v1/users/me/messages/id");
    await expect(fetcher("https://gmail.googleapis.com/gmail/v1/users/me/messages/id")).rejects.toMatchObject({ reason: "localBudget" });
    expect(upstream).toHaveBeenCalledTimes(270);
    time += 60_001; await fetcher("https://gmail.googleapis.com/gmail/v1/users/me/messages/id");
    expect(upstream).toHaveBeenCalledTimes(271);
  });
});

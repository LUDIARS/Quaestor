import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailInboxError, type MailSource } from "@ludiars/mail-inbox";
import { applyMigrations } from "../src/db/schema.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { MailCrawlStateRepo } from "../src/db/mail-crawl-state-repo.js";
import { MailCrawler } from "../src/services/mail-crawler.js";
import { classifyMailCrawlFailure } from "../src/services/mail-crawl-failure.js";
import { GmailRateLimit } from "../src/services/gmail-rate-limit.js";
import type { MailIdSource } from "../src/services/gmail-crawl-source.js";

const SECRET = "ya29.secret-access-token refresh=1//secret-refresh client_secret=GOCSPX-secret subject=Invoice to=a@example.test";

describe("mail crawl failure classification", () => {
  it("separates OAuth refresh rejection, Gmail HTTP status, network and unknown failures", () => {
    expect(classifyMailCrawlFailure(new MailInboxError("auth", "OAuth token refresh was rejected", 400), "list_ids", 1))
      .toEqual({ stage: "list_ids", category: "gmail_auth_refresh_rejected", errorClass: "MailInboxError", status: 400, at: 1 });
    expect(classifyMailCrawlFailure(new MailInboxError("auth", "OAuth token refresh failed"), "list_ids", 1).category).toBe("gmail_auth_network");
    expect(classifyMailCrawlFailure(new MailInboxError("auth", "Gmail authentication failed", 401), "process", 1).category).toBe("gmail_401");
    expect(classifyMailCrawlFailure(new Error("gmail_http_401"), "list_ids", 2))
      .toEqual({ stage: "list_ids", category: "gmail_401", errorClass: "Error", status: 401, at: 2 });
    expect(classifyMailCrawlFailure(new TypeError("fetch failed", { cause: Object.assign(new Error(SECRET), { code: "ECONNRESET" }) }), "list_ids", 3))
      .toEqual({ stage: "list_ids", category: "network", errorClass: "TypeError", code: "ECONNRESET", at: 3 });
    expect(classifyMailCrawlFailure(new DOMException("timed out", "TimeoutError"), "list_ids", 4).category).toBe("network_timeout");
    expect(classifyMailCrawlFailure(new GmailRateLimit(9, 429, "userRateLimitExceeded"), "process", 5))
      .toMatchObject({ category: "gmail_rate_limit", status: 429, reason: "userRateLimitExceeded" });
    expect(classifyMailCrawlFailure(new Error("Gmail is not configured"), "list_ids", 6).category).toBe("gmail_unconfigured");
    expect(classifyMailCrawlFailure("boom", "process", 7)).toEqual({ stage: "process", category: "unknown", errorClass: "unknown", at: 7 });
  });
  it("never copies exception messages or unsafe codes into the classification", () => {
    const error = Object.assign(new Error(SECRET), { code: SECRET, cause: { code: "Bearer ya29.secret" } });
    const failure = classifyMailCrawlFailure(error, "process", 8);
    expect(failure).toEqual({ stage: "process", category: "unknown", errorClass: "Error", at: 8 });
    expect(JSON.stringify(failure)).not.toMatch(/secret|ya29|GOCSPX|Invoice|example\.test/);
  });
});

describe("mail crawler failure reporting", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());
  it("logs and exposes the classified failure while keeping the legacy lastError value", async () => {
    const warn = vi.fn();
    const listIds = vi.fn(async () => { throw new MailInboxError("auth", "OAuth token refresh was rejected", 400); });
    const crawler = new MailCrawler({ source: { listIds } as unknown as MailSource & MailIdSource, messages: new MailMessagesRepo(db),
      state: new MailCrawlStateRepo(db), query: "in:inbox", ready: () => true, process: async () => true, now: () => 100_000,
      logger: { warn } });
    await crawler.tick();
    const expected = { stage: "list_ids", category: "gmail_auth_refresh_rejected", errorClass: "MailInboxError", status: 400, at: 100_000 };
    expect(crawler.status()).toMatchObject({ lastError: "mail_crawl_failed", failures: 1, lastFailure: expected });
    expect(warn).toHaveBeenCalledWith({ ...expected, failures: 1 }, "mail crawl tick failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("OAuth token refresh was rejected");
  });
  it("attributes body processing failures to the process stage", async () => {
    const warn = vi.fn();
    const listIds = vi.fn(async () => ({ ids: ["a"], nextPageToken: null }));
    const crawler = new MailCrawler({ source: { listIds } as unknown as MailSource & MailIdSource, messages: new MailMessagesRepo(db),
      state: new MailCrawlStateRepo(db), query: "in:inbox", ready: () => true, now: () => 100_000, logger: { warn },
      process: async () => { throw new MailInboxError("network", "Gmail API request failed"); } });
    await crawler.tick();
    expect(crawler.status().lastFailure).toMatchObject({ stage: "process", category: "network" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

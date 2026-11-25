import { randomUUID } from "node:crypto";
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, env, endpoint, startMs, endMs } from "./fixtures/mail-recovery.js";
import { GmailRateLimit } from "../src/services/gmail-rate-limit.js";
import { MailCrawler } from "../src/services/mail-crawler.js";
import { MailAnalysisRepo } from "../src/db/mail-analysis-repo.js";
import { MailWatchStateRepo } from "../src/db/mail-watch-state-repo.js";
import { InboundDocumentsRepo } from "../src/db/inbound-documents-repo.js";

describe("bounded Gmail recovery through the Qs operator entry", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => {
    try { f?.assertQuiet(); }
    finally { f = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });

  it.each([
    ["invoice", 1, 0], ["cloud", 1, 0], ["ci-failure", 0, 1], ["dependency", 0, 1],
  ] as const)("performs only local work for %s", async (id, imported, deferred) => {
    f = await fixture([id], { productionSource: id === "cloud" });
    const dry = await f.finish();
    expect(dry).toMatchObject({ phase: "finished", exhausted: true, counts: { pages: 2, missing: 1, imported: 0 } });
    expect(f.full).toHaveLength(0);
    expect(f.messages.find(id)).toBeUndefined();
    const result = await f.finish(dry.request_id);
    expect(result).toMatchObject({ phase: "finished", counts: { imported, deferred, unresolved: 0 } });
    expect(f.messages.list()).toHaveLength(imported);
    if (id === "invoice") {
      expect(f.db.prepare("SELECT status FROM inbound_documents").all()).toEqual([{ status: "committed" }]);
      expect(f.db.prepare("SELECT total FROM receipts").all()).toEqual([{ total: 1200 }]);
    }
    const again = await f.finish(dry.request_id);
    expect(again.counts).toMatchObject({ imported: 0, terminal: imported, deferred });
    expect((await f.finish()).counts).toMatchObject({ missing: deferred, terminal: imported });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|fixture-secret|thread-fixture|fixture@example/);
  });

  it("checks every unique internal date, excludes existing rows and preserves the normal cursor", async () => {
    f = await fixture(["known", "cloud", "busy", "error", "early", "end", "cloud", "unknown"]);
    f.dates.set("cloud", endMs - 1); f.dates.set("early", startMs - 1); f.dates.set("end", endMs);
    f.claim("known", "ignored"); f.claim("busy", "processing"); f.claim("error", "error");
    const state = { ...f.state.load(f.query), pending: ["normal-fixture"], pageToken: "normal-token", processed: 21 };
    f.state.save(state);
    const dry = await f.finish();
    expect(dry.counts).toMatchObject({ pages: 2, examined: 7, outside: 2, duplicate: 1, terminal: 1,
      processing: 1, existingError: 1, missing: 2, imported: 0 });
    const result = await f.finish(dry.request_id);
    expect(result.counts).toMatchObject({ imported: 1, deferred: 1, unresolved: 0 });
    expect(f.full).toEqual(["cloud", "unknown"]);
    expect(f.state.load(f.query)).toEqual(state);
    expect(f.messages.find("unknown")).toBeUndefined();
    const stored = JSON.stringify(f.db.prepare("SELECT status_json FROM mail_recovery_jobs").all());
    expect(stored).not.toMatch(/normal-token|fixture|private-fixture|example\.test/);
  });

  it("requires a local peer, operator session and CSRF on status and mutations", async () => {
    f = await fixture(["cloud"]);
    const data = f.body();
    for (const [url, extra, connection] of [
      [endpoint, { Cookie: "" }, env],
      [endpoint, { "X-Qs-Csrf": "" }, env],
      [endpoint, { Origin: "https://elsewhere.example" }, env],
      [endpoint, { "X-Forwarded-Prefix": "/viewer" }, env],
      [endpoint, { "X-Forwarded-For": "192.0.2.1" }, env],
      [endpoint.replace("127.0.0.1:17400", "operator.example.test"), {}, env],
      [endpoint, {}, { incoming: { socket: { remoteAddress: "192.0.2.1" } } }],
    ] as const) {
      const headers = { ...f.headers, ...extra };
      expect((await f.app.request(url, { method: "POST", headers, body: JSON.stringify(data) }, connection)).status).toBe(403);
      expect((await f.app.request(url + "/" + data.request_id, { headers }, connection)).status).toBe(403);
    }
    expect((await f.post({ ...data, endUtc: new Date(endMs + 1).toISOString() })).status).toBe(400);
    expect((await f.post({ ...data, query: "broader" })).status).toBe(400);
    expect((await f.post(f.body(randomUUID()))).status).toBe(409);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("keeps the public setup, Viewer and direct recovery origins separate", async () => {
    f = await fixture([]);
    const publicOrigin = "https://operator.example.test";
    const setup = "/v1/gmail-auth/setup";
    expect((await f.app.request(publicOrigin + setup, {}, env)).status).toBe(200);
    expect((await f.app.request(new URL(setup, endpoint).href, {}, env)).status).toBe(403);
    const publicEndpoint = publicOrigin + new URL(endpoint).pathname;
    for (const data of [f.body(), f.body(randomUUID())]) {
      for (const [url, headers] of [
        [publicEndpoint, f.headers], [endpoint, { ...f.headers, "X-Forwarded-Prefix": "/viewer/quaestor" }],
        [endpoint, { Origin: publicOrigin, "Sec-Fetch-Site": "cross-site" }],
      ] as const) {
        expect((await f.app.request(url, { method: "POST", headers, body: JSON.stringify(data) }, env)).status).toBe(403);
        expect((await f.app.request(url + "/" + data.request_id, { headers }, env)).status).toBe(403);
      }
    }
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it.each(["unknown date", "repeated token", "malformed page", "page read failed"])(
    "does not authorize import after %s", async fault => {
      f = await fixture(["cloud", "unknown"]);
      if (fault === "unknown date") f.dates.delete("unknown");
      if (fault === "repeated token") f.listing.mockResolvedValue({ messages: [], nextPageToken: "loop" });
      if (fault === "malformed page") f.upstream.mockResolvedValueOnce(Response.json([]));
      if (fault === "page read failed") f.listing.mockRejectedValueOnce(new Error("private-fixture"));
      const dry = await f.finish();
      expect(dry.phase).toBe("partial");
      expect((await f.post(f.body(dry.request_id))).status).toBe(409);
      expect(f.full).toHaveLength(0);
      expect(f.messages.list()).toHaveLength(0);
    });

  it("rechecks coverage and skips a row claimed after the import scan", async () => {
    f = await fixture(["cloud", "unknown"]);
    const dry = await f.finish();
    f.dates.delete("unknown");
    const incomplete = await f.finish(dry.request_id);
    expect(incomplete).toMatchObject({ phase: "partial", counts: { unknownDate: 1, imported: 0 } });
    expect(f.full).toEqual([]);
    f.dates.set("unknown", startMs);
    const get = f.source.get.bind(f.source);
    vi.spyOn(f.source, "get").mockImplementation(async (id, options) => {
      const message = await get(id, options);
      if (id === "cloud") f!.claim(id, "already_handled");
      return message;
    });
    expect((await f.finish(dry.request_id)).counts).toMatchObject({ imported: 0, raced: 1, deferred: 1 });
    expect(f.messages.find("cloud")?.outcome).toBe("already_handled");
  });

  it("reserves the worker through completion, replays request IDs, and resumes after quota", async () => {
    f = await fixture(["cloud"]);
    const read = vi.spyOn(f.source, "internalDate").mockRejectedValueOnce(new GmailRateLimit(Date.now() + 180, 0, "localBudget"));
    const data = f.body();
    expect((await f.post(data)).status).toBe(202);
    await vi.waitFor(async () => expect((await f!.status(data.request_id)).retryAt).not.toBeNull(), { interval: 5 });
    expect((await f.post(data)).status).toBe(202);
    expect((await f.post(f.body())).status).toBe(409);
    const backfill = await f.app.request("http://127.0.0.1/v1/mail/crawler/backfill", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: "normal-fixture", limit: 1 }) }, env);
    expect(backfill.status).toBe(202);
    await vi.waitFor(async () => expect((await f!.status(data.request_id)).phase).toBe("finished"));
    expect((await f.post(data)).status).toBe(200);
    expect((await f.post(f.body(data.request_id, data.request_id))).status).toBe(409);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.listing).toHaveBeenCalledTimes(2);
  });

  it("can interrupt a cooldown, recover persisted status and require a fresh dry run after restart", async () => {
    f = await fixture(["cloud"], { reopenDatabase: true });
    const oldSession = f.headers;
    const dry = await f.finish();
    vi.spyOn(f.source, "internalDate").mockRejectedValueOnce(new GmailRateLimit(Date.now() + 60_000, 0, "localBudget"));
    const input = f.body(dry.request_id);
    expect((await f.post(input)).status).toBe(202);
    await vi.waitFor(async () => expect((await f!.status(input.request_id)).retryAt).not.toBeNull());
    await f.restart();
    expect((await f.post(f.body(), oldSession)).status).toBe(403);
    expect(await f.status(input.request_id)).toMatchObject({ phase: "interrupted", counts: { imported: 0 } });
    expect((await f.post(f.body(dry.request_id))).status).toBe(409);
    const next = await f.finish();
    expect((await f.finish(next.request_id)).counts.imported).toBe(1);
  });

  it("records partial import on provider throttling and only imports the remainder on retry", async () => {
    f = await fixture(["cloud", "invoice"]);
    const dry = await f.finish();
    const get = f.source.get.bind(f.source);
    const now = Date.now.bind(Date);
    const retryAt = now() + 60_000;
    const read = vi.spyOn(f.source, "get").mockImplementation(async (id, opts) => {
      if (id === "invoice") throw new GmailRateLimit(retryAt, 429, "userRateLimitExceeded");
      return get(id, opts);
    });
    const interrupted = await f.finish(dry.request_id);
    expect(interrupted).toMatchObject({ phase: "partial", retryAt, counts: { imported: 1, failures: 1 } });
    expect(f.messages.find("invoice")).toBeUndefined();
    expect((await f.post(f.body(dry.request_id))).status).toBe(429);
    read.mockRestore();
    vi.spyOn(Date, "now").mockImplementation(() => now() + 60_001);
    expect((await f.finish(dry.request_id)).counts).toMatchObject({ imported: 1, terminal: 1 });
    expect(f.messages.list()).toHaveLength(2);
  });

  it("honors the JST boundaries and invalidates a dry run when the Gmail credential changes", async () => {
    f = await fixture(["cloud"]);
    const data = f.body();
    const response = await f.post({ ...data, startUtc: "2026-10-03T10:00:00+09:00", endUtc: "2026-11-25T10:48:48+09:00" });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => expect((await f!.status(data.request_id)).phase).toBe("finished"));
    vi.spyOn(f.oauth, "connectionRevision", "get").mockReturnValue("different-connection");
    expect((await f.post(f.body(data.request_id))).status).toBe(409);
    expect(f.full).toHaveLength(0);
  });

  it("keeps a failed invoice separate and still imports later local messages", async () => {
    f = await fixture(["invoice", "cloud"]);
    const dry = await f.finish();
    vi.spyOn(f.source, "loadAttachment").mockResolvedValue(Buffer.from("fixture-invalid-pdf"));
    expect(await f.finish(dry.request_id)).toMatchObject({ phase: "partial", counts: { imported: 1, unresolved: 1 } });
    expect(f.messages.find("invoice")?.outcome).toBe("error");
    expect((await f.finish(dry.request_id)).counts).toMatchObject({ imported: 0, existingError: 1, terminal: 1 });
  });

  it("skips a PDF claimed by ordinary intake while recovery waits to retry its attachment", async () => {
    f = await fixture(["invoice"]);
    const dry = await f.finish();
    const attachment = vi.spyOn(f.source, "loadAttachment").mockImplementationOnce(async () => {
      f!.claim("invoice", "processing");
      throw new GmailRateLimit(Date.now() + 10, 0, "localBudget");
    });
    const result = await f.finish(dry.request_id);
    expect(result.counts).toMatchObject({ imported: 0, raced: 1, unresolved: 0, failures: 0 });
    expect(attachment).toHaveBeenCalledOnce();
    expect(f.db.prepare("SELECT COUNT(*) FROM inbound_documents").pluck().get()).toBe(0);
  });

  it("keeps one document when another mail ID stores the same PDF during import", async () => {
    f = await fixture(["invoice"]);
    const fx = f;
    const dry = await fx.finish();
    fx.claim("other-invoice", "needs_review");
    const insert = InboundDocumentsRepo.prototype.insert;
    let directory = "";
    vi.spyOn(InboundDocumentsRepo.prototype, "insert").mockImplementationOnce(function (this: InboundDocumentsRepo, row) {
      if (row.source === "scan") throw new Error("unexpected fixture source");
      directory = dirname(row.file_path);
      const otherPath = join(directory, "other.pdf");
      copyFileSync(join(fx.root, row.file_path), join(fx.root, otherPath));
      insert.call(this, { ...row, id: randomUUID(), message_id: "other-invoice", file_path: otherPath });
      return insert.call(this, row);
    });
    expect((await fx.finish(dry.request_id)).counts).toMatchObject({ imported: 1, unresolved: 0 });
    expect(fx.messages.find("invoice")?.outcome).toBe("duplicate");
    expect(fx.db.prepare("SELECT COUNT(*) FROM inbound_documents").pluck().get()).toBe(1);
    expect(fx.db.prepare("SELECT COUNT(*) FROM receipts").pluck().get()).toBe(0);
    expect(readdirSync(join(fx.root, directory))).toEqual(["other.pdf"]);
  });

  it("shares a provider cooldown between recovery and ordinary Gmail reads", async () => {
    f = await fixture(["cloud"]);
    f.upstream.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "Retry-After": "120" } }));
    const stopped = await f.finish();
    expect(stopped).toMatchObject({ phase: "partial", counts: { imported: 0, failures: 1 } });
    expect(stopped.retryAt).toBeGreaterThan(Date.now());
    await expect(f.source.get("cloud")).rejects.toMatchObject({ retryAt: stopped.retryAt });
    expect((await f.post(f.body())).status).toBe(429);
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });

  it.each(["dry_run", "import_missing"])("advances the normal crawler and watch while %s is waiting", async mode => {
    f = await fixture(["overlap", "cloud", "overlap"], { realtime: true });
    const fx = f;
    fx.dates.set("cloud", endMs - 1);
    const basis = mode === "import_missing" ? (await fx.finish()).request_id : undefined;
    const data = fx.body(basis);
    const crawlerStatus = vi.spyOn(MailCrawler.prototype, "status");
    const mail = new URL("/v1/mail/", endpoint).href;
    expect((await fx.app.request(mail + "crawler", {}, env)).status).toBe(200);
    const crawler = crawlerStatus.mock.contexts[0]!;
    if (!(crawler instanceof MailCrawler)) throw new Error("expected the application crawler");
    fx.state.save({ ...fx.state.load(fx.query), pending: ["overlap"], endOfScan: true });
    new MailAnalysisRepo(fx.db).save("overlap", { kind: "review", confidence: 0.9 });
    const watchState = new MailWatchStateRepo(fx.db);
    watchState.setHistoryId("100");
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const pause = vi.fn(() => waiting);
    if (basis) {
      const get = fx.source.get.bind(fx.source);
      vi.spyOn(fx.source, "get").mockImplementationOnce(async (...args) => { await pause(); return get(...args); });
    } else {
      const date = fx.source.internalDate.bind(fx.source);
      vi.spyOn(fx.source, "internalDate").mockImplementationOnce(async id => { await pause(); return date(id); });
    }
    try {
      expect((await fx.post(data)).status).toBe(202);
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      expect((await fx.post(data)).status).toBe(202);
      expect((await fx.post(fx.body())).status).toBe(409);
      const tick = crawler.tick();
      await vi.waitFor(() => expect(fx.state.load(fx.query).processed).toBe(1));
      await tick;
      expect(fx.messages.find("overlap")?.outcome).toBe("analysis_review: review");
      const sync = fx.app.request(mail + "sync", { method: "POST" }, env);
      await vi.waitFor(() => expect(watchState.get()?.history_id).toBe("101"));
      expect(await (await sync).json()).toMatchObject({ fetched: 1, history_id: "101", errors: [] });
      expect((await fx.status(data.request_id)).phase).toBe(basis ? "importing" : "scanning");
      const cursor = fx.state.load(fx.query);
      const history = watchState.get();
      release();
      await vi.waitFor(async () => expect((await fx.status(data.request_id)).phase).toBe("finished"));
      const result = await fx.status(data.request_id);
      expect(result.counts).toMatchObject({ pages: 2, examined: 2, duplicate: 1,
        terminal: basis ? 0 : 1, raced: basis ? 1 : 0, imported: basis ? 1 : 0 });
      expect(fx.state.load(fx.query)).toEqual(cursor);
      expect(watchState.get()).toEqual(history);
    } finally { release(); }
  });
});

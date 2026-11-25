import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, onTestFinished, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { GmailOAuth } from "../../src/services/gmail-oauth.js";
import { GMAIL_SETUP_COOKIE } from "../../src/api/gmail-oauth.js";
import { GmailCrawlSource } from "../../src/services/gmail-crawl-source.js";
import { gmailPacedFetch } from "../../src/services/gmail-paced-fetch.js";
import { MailMessagesRepo } from "../../src/db/mail-messages-repo.js";
import { MailCrawlStateRepo } from "../../src/db/mail-crawl-state-repo.js";
import { MailActions } from "../../src/services/mail-actions.js";
import { NotificationService } from "../../src/services/notification-service.js";
import { MailLunaAnalysis } from "../../src/services/mail-luna-analysis.js";
import { AnthropicOcrClient } from "../../src/services/ocr-client.js";
import { SesEmailClient } from "../../src/services/ses-email-client.js";
import { MailIgnoreEngine } from "../../src/services/mail-ignore-engine.js";
import { WINDOW_START, WINDOW_END, type RecoveryJob } from "../../src/services/mail-recovery-window.js";

const local = "http://127.0.0.1:17400";
export const endpoint = local + "/v1/gmail-auth/recovery";
export const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
export const startMs = Date.parse(WINDOW_START);
export const endMs = Date.parse(WINDOW_END);
const query = "{in:inbox label:fixture}";
const secret = "fixture-secret";

function invoicePdf(): Buffer {
  const stream = "BT /F1 12 Tf 20 200 Td (Invoice 2026/11/02 Total 1200) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}`;
  return Buffer.from(pdf + `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii");
}

export async function fixture(ids: string[], options: { productionSource?: boolean; reopenDatabase?: boolean; realtime?: boolean } = {}) {
  const { productionSource, reopenDatabase } = options;
  const root = mkdtempSync(join(tmpdir(), "qs-recovery-"));
  const databaseName = reopenDatabase ? join(root, "fixture.sqlite") : ":memory:";
  let db = new Database(databaseName);
  const cleanup: (() => void | Promise<void>)[] = [];
  const cleanupApp = async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); };
  const close = async () => {
    try { await cleanupApp(); }
    finally {
      if (db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
  // Covers failures during app construction, before the test receives this fixture.
  onTestFinished(close);
  const blocked = () => { throw new Error("unexpected external action"); };
  const outward = [
    vi.spyOn(NotificationService.prototype, "notifyMailInvoice").mockImplementation(blocked),
    vi.spyOn(NotificationService.prototype, "notifyMailCloudNotice").mockImplementation(blocked),
    vi.spyOn(NotificationService.prototype, "notifyMailAction").mockImplementation(blocked),
    vi.spyOn(MailActions.prototype, "handle").mockImplementation(blocked),
    vi.spyOn(MailLunaAnalysis.prototype, "analyze").mockImplementation(blocked),
    vi.spyOn(AnthropicOcrClient.prototype, "extract").mockImplementation(blocked),
    vi.spyOn(SesEmailClient.prototype, "sendMessage").mockImplementation(blocked),
    vi.spyOn(MailIgnoreEngine.prototype, "observe").mockImplementation(blocked),
  ];
  const unexpectedFetch = vi.fn(blocked);
  const dates = new Map(ids.map(id => [id, startMs]));
  const full: string[] = [], metadata: string[] = [];
  const file = invoicePdf();
  const listing = vi.fn(async (token: string | null) => token ? { messages: ids.slice(1).map(id => ({ id })) }
    : { messages: ids.slice(0, 1).map(id => ({ id })), nextPageToken: "page-two" });
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://gmail.googleapis.com" || (init?.method ?? "GET") !== "GET"
      || new Headers(init?.headers).get("authorization") !== "Bearer fixture-access") return unexpectedFetch();
    const path = "/gmail/v1/users/me/messages";
    if (options.realtime && url.pathname === "/gmail/v1/users/me/history" && url.searchParams.get("startHistoryId") === "100") {
      return Response.json({ historyId: "101", history: [{ messagesAdded: [{ message: { id: "overlap" } }] }] });
    }
    if (url.pathname === path) {
      expect(url.searchParams.get("q")).toBe(`(${query}) after:${startMs / 1000 - 1} before:${endMs / 1000}`);
      return Response.json(await listing(url.searchParams.get("pageToken")));
    }
    if (url.pathname === path + "/invoice/attachments/fixture-pdf") return Response.json({ data: file.toString("base64url") });
    const id = url.pathname.slice(path.length + 1);
    if (!ids.includes(id) || !url.pathname.startsWith(path + "/")) return unexpectedFetch();
    const internalDate = dates.has(id) ? String(dates.get(id)) : undefined;
    if (url.searchParams.get("format") === "minimal") {
      expect(url.searchParams.get("fields")).toBe("id,internalDate");
      metadata.push(id);
      return Response.json({ id, internalDate });
    }
    if (url.searchParams.get("format") !== "full") return unexpectedFetch();
    full.push(id);
    return Response.json({ id, threadId: "thread-fixture", internalDate, payload: { mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "Fixture <fixture@example.test>" }, { name: "Subject", value: id + " private-fixture" }],
      parts: id === "invoice" ? [{ mimeType: "application/pdf", filename: "fixture.pdf",
        body: { size: file.length, attachmentId: "fixture-pdf" } }] : [] } });
  });
  vi.stubGlobal("fetch", productionSource ? upstream : unexpectedFetch);
  function connection() {
    const oauth = new GmailOAuth({ loadStrict: () => ({ QUAESTOR_GMAIL_CLIENT_ID: "fixture-client",
      QUAESTOR_GMAIL_CLIENT_SECRET: secret, QUAESTOR_GMAIL_REFRESH_TOKEN: secret }), setMany: blocked }, "https://operator.example.test");
    vi.spyOn(oauth, "getAccessToken").mockResolvedValue("fixture-access");
    return { oauth, source: new GmailCrawlSource({ auth: oauth, fetchImpl: gmailPacedFetch(upstream, async () => {}) }) };
  }
  let { oauth, source } = connection();
  const build = () => buildApp({ db, receiptsRoot: root, gmailOAuth: oauth, mailSource: productionSource ? undefined : source,
    trainingRoot: join(root, "training"), gaRoot: join(root, "ga"), notifyStatePath: join(root, "notify.json"),
    allocationAdvicePath: join(root, "advice.json"), slackInvoiceNotifier: "disabled", securityMapper: "disabled",
    perkClient: "disabled", dividendClient: "disabled", stockClient: "disabled", planReviewer: "disabled",
    subsidyMatcher: "disabled", subsidyCrawler: "disabled", allocationAdvisor: "disabled", apportionmentLlm: "disabled",
    registerCleanup: fn => cleanup.push(fn), discordNotifier: "disabled", ocr: "disabled", invoiceEmailNotifier: "disabled",
    mailIntake: { enabled: true, query, documentsRoot: root, maxAttachmentBytes: 16_384,
      realtime: { enabled: options.realtime === true, topicName: null, subscriptionName: null, labelIds: [], repoAllowlist: [] },
      rules: [{ kind: "invoice", subjectAny: ["invoice"] }, { kind: "cloud_notice", subjectAny: ["cloud"] },
        { kind: "ci_failure", subjectAny: ["ci-failure"] }, { kind: "dependabot", subjectAny: ["dependency"] }] } });
  let app = build();
  function operatorSession() {
    // Seed only the in-memory fixture. This tests the backend contract independently of browser access.
    const session = oauth.session();
    return { Cookie: GMAIL_SETUP_COOKIE + "=" + session.id, "X-Qs-Csrf": session.csrf, "Content-Type": "application/json" };
  }
  let headers = operatorSession();
  const post = (data: unknown, auth = headers) => app.request(endpoint, { method: "POST", headers: auth, body: JSON.stringify(data) }, env);
  const body = (basis?: string, id = randomUUID()) => ({ request_id: id, startUtc: WINDOW_START, endUtc: WINDOW_END,
    ...(basis ? { mode: "import_missing", dry_run_id: basis } : { mode: "dry_run" }) });
  const status = async (id: string): Promise<RecoveryJob> => {
    const res = await app.request(endpoint + "/" + id, { headers }, env);
    expect(res.status).toBe(200);
    return await res.json() as RecoveryJob;
  };
  const finish = async (basis?: string) => {
    const data = body(basis);
    expect((await post(data)).status).toBe(202);
    let result!: RecoveryJob;
    await vi.waitFor(async () => {
      result = await status(data.request_id);
      expect(["finished", "partial", "interrupted"]).toContain(result.phase);
    }, { timeout: 12_000, interval: 10 });
    return result;
  };
  let messages = new MailMessagesRepo(db);
  let state = new MailCrawlStateRepo(db);
  const claim = (id: string, outcome: string) => messages.claim({ message_id: id, thread_id: null, from_address: "", subject: "",
    kind: "ignore", received_at: 0, processed_at: 0, rule_index: null, outcome, error: null });
  return { get db() { return db; }, get app() { return app; }, get headers() { return headers; },
    get source() { return source; }, get oauth() { return oauth; }, get messages() { return messages; }, get state() { return state; },
    post, body, status, finish, claim, query, dates, listing, full, metadata, upstream, root,
    assertQuiet() { for (const spy of [...outward, unexpectedFetch]) expect(spy).not.toHaveBeenCalled(); },
    restart: async () => {
      if (!reopenDatabase) throw new Error("restart fixture needs a persistent database");
      await cleanupApp();
      db.close();
      db = new Database(databaseName);
      ({ oauth, source } = connection());
      app = build();
      headers = operatorSession();
      messages = new MailMessagesRepo(db);
      state = new MailCrawlStateRepo(db);
    },
  };
}

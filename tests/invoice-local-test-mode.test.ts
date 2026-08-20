import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { applyMigrations } from "../src/db/schema.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import { InvoiceDeliveryContactsRepo } from "../src/db/invoice-delivery-contacts-repo.js";
import { InvoiceShareService, InvoiceShareError } from "../src/services/invoice-share-service.js";
import { InvoiceShareRepo } from "../src/db/invoice-share-repo.js";
import { InvoicePasskeyService, InvoicePasskeyError } from "../src/services/invoice-passkey-service.js";
import { OutboxFileNotifier } from "../src/services/outbox-file-notifier.js";
import { FakeAuthenticator } from "./helpers/fake-authenticator.js";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n", "ascii");
const LOCAL_ORIGIN = "http://localhost:17400";

function makeRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("invoiceShare.localTest", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("share service: http://localhost はフラグ有効時のみ、 他の http は常に 503", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const base = {
      shares: new InvoiceShareRepo(db),
      invoices: new InvoicesRepo(db),
    };
    const attempt = async (publicBaseUrl: string, allowLocalHttpOrigin: boolean) => {
      const service = new InvoiceShareService({ ...base, publicBaseUrl, allowLocalHttpOrigin });
      try {
        await service.create({ invoiceId: 1, documentPath: "missing.pdf" });
        return "created";
      } catch (error) {
        if (error instanceof InvoiceShareError) return error.code;
        throw error;
      }
    };
    // buildApp を通さない裸の repo なので invoice が無く、 not_configured 以外まで進めば URL は受理されている
    expect(await attempt(LOCAL_ORIGIN, false)).toBe("not_configured");
    expect(await attempt(LOCAL_ORIGIN, true)).not.toBe("not_configured");
    expect(await attempt("http://127.0.0.1:17400", true)).toBe("not_configured");
    expect(await attempt("http://qs.example.com", true)).toBe("not_configured");
    expect(await attempt("https://qs.example.com", false)).not.toBe("not_configured");
    db.close();
  });

  it("passkey service: RP origin も同じ規則 (localhost のみ・フラグ必須)", async () => {
    const ready = (publicUrl: string, allowLocalHttpOrigin: boolean) => {
      const service = new InvoicePasskeyService({ publicUrl, allowLocalHttpOrigin });
      return service.authenticationOptions({ challenge: Buffer.alloc(32), allowCredentials: [] })
        .then(() => true, (error) => (error instanceof InvoicePasskeyError && error.code === "not_configured" ? false : true));
    };
    expect(await ready(LOCAL_ORIGIN, true)).toBe(true);
    expect(await ready(LOCAL_ORIGIN, false)).toBe(false);
    expect(await ready("http://127.0.0.1:17400", true)).toBe(false);
    expect(await ready("http://attacker.example.com", true)).toBe(false);
  });

  it("outbox notifier: 本文と添付をファイルとして書き出す", async () => {
    const dir = makeRoot("quaestor-outbox-");
    roots.push(dir);
    const notifier = new OutboxFileNotifier({ dir, now: () => new Date("2026-08-20T00:00:00Z") });
    const result = await notifier.sendMessage({
      to: "r@example.com",
      subject: "テスト件名",
      text: "本文",
      attachments: [{ filename: "evidence.json", contentType: "application/json", content: Buffer.from("{}") }],
    });
    expect(result.messageId).toMatch(/^outbox-/);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const body = readFileSync(join(dir, files.find((f) => f.endsWith(".txt"))!), "utf8");
    expect(body).toContain("To: r@example.com");
    expect(body).toContain("テスト件名");
    expect(body).toContain("本文");
    expect(body).toContain("evidence.json");
  });

  it("e2e: localhost origin で発行 → OTP → 登録 → 署名まで通る (メールは outbox 相当の注入 notifier)", async () => {
    const root = makeRoot("quaestor-localtest-");
    roots.push(root);
    const pdfPath = join(root, "invoice.pdf");
    writeFileSync(pdfPath, PDF);
    const db = new Database(":memory:");
    const sent: { text: string }[] = [];
    const app = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: LOCAL_ORIGIN, roots: [root], localTest: true },
      unsafeExposeInvoiceShareUrl: true,
      invoiceEmailNotifier: {
        assertReady: () => undefined,
        sendMessage: async (message) => { sent.push(message); return { messageId: `m-${sent.length}` }; },
      },
    });
    const invoiceId = new InvoicesRepo(db).insert({
      issued_at: "2026-08-01", due_date: "2026-08-31", client: "Local", work_summary: "x", amount: 100,
    });
    const recipientId = new InvoiceDeliveryContactsRepo(db).insert({
      companyName: "Local Test", email: "local@example.com",
    }).id;
    const createRes = await app.request(`/v1/invoices/${invoiceId}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath, recipient_id: recipientId }),
    });
    expect(createRes.status, await createRes.clone().text()).toBe(201);
    const created = await createRes.json() as { share_url: string };
    expect(created.share_url.startsWith(`${LOCAL_ORIGIN}/v1/invoices/share/`)).toBe(true);
    const token = created.share_url.slice(created.share_url.lastIndexOf("/") + 1);

    await app.request(`/v1/invoices/share/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=accepted",
    });
    const challengeId = (await (await app.request(`/v1/invoices/share/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=accepted",
    })).text()).match(/name="challenge_id" value="([^"]+)"/)?.[1];
    const code = sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
    const enrollPage = await (await app.request(`/v1/invoices/share/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ challenge_id: challengeId!, code: code! }).toString(),
    })).text();
    const grantId = enrollPage.match(/data-grant="([^"]+)"/)?.[1];
    expect(grantId).toBeTruthy();

    const authenticator = new FakeAuthenticator();
    const postJson = (path: string, body: unknown) => app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const reg = await (await postJson(`/v1/invoices/share/${token}/passkey/options`, { purpose: "register", grant_id: grantId })).json() as { challenge_id: string; options: { challenge: string; rp: { id?: string } } };
    expect(reg.options.rp.id).toBe("localhost");
    expect((await postJson(`/v1/invoices/share/${token}/passkey/register`, {
      grant_id: grantId, challenge_id: reg.challenge_id, response: authenticator.register(reg.options, LOCAL_ORIGIN),
    })).status).toBe(201);
    const assert = await (await postJson(`/v1/invoices/share/${token}/passkey/options`, { purpose: "assert" })).json() as { challenge_id: string; options: { challenge: string; rpId?: string } };
    expect(assert.options.rpId).toBe("localhost");
    const accept = await postJson(`/v1/invoices/share/${token}/passkey/accept`, {
      challenge_id: assert.challenge_id, response: authenticator.assert(assert.options, LOCAL_ORIGIN),
    });
    expect(accept.status).toBe(201);
    db.close();
  });
});

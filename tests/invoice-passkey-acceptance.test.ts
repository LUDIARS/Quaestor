import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createHash, createVerify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import { InvoiceDeliveryContactsRepo } from "../src/db/invoice-delivery-contacts-repo.js";
import type { InvoiceEmailMessage, InvoiceEmailNotifier } from "../src/services/invoice-email-notifier.js";
import {
  evidenceSha256OfBundle,
  type InvoiceAcceptanceEvidenceBundle,
} from "../src/services/invoice-acceptance-evidence-bundle.js";
import { Rfc3161TimestampClient } from "../src/services/rfc3161-timestamp-client.js";
import { FakeAuthenticator } from "./helpers/fake-authenticator.js";
import { fakeRfc3161Response } from "./helpers/fake-rfc3161.js";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n", "ascii");
const ORIGIN = "https://qs-magiclink.example.com";
const NONCE = Buffer.from("0102030405060708", "hex");

function makeRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function fakeTimestampResponse(imprintHex: string): Buffer {
  return fakeRfc3161Response({ imprint: Buffer.from(imprintHex, "hex"), nonce: NONCE });
}

describe("API: passkey acceptance", () => {
  let db: Database.Database;
  let root: string;
  let pdfPath: string;
  let app: ReturnType<typeof buildApp>;
  let invoiceId: number;
  let recipientId: string;
  let sentMessages: InvoiceEmailMessage[];
  let tsaRequests: Buffer[];
  let tsaMode: "granted" | "down";
  let emailMode: "ok" | "fail";
  let logWarnings: { fields: Record<string, unknown>; message?: string }[];

  beforeEach(() => {
    root = makeRoot("quaestor-passkey-api-");
    pdfPath = join(root, "invoice.pdf");
    writeFileSync(pdfPath, PDF);
    db = new Database(":memory:");
    sentMessages = [];
    tsaRequests = [];
    tsaMode = "granted";
    emailMode = "ok";
    logWarnings = [];
    const emailNotifier: InvoiceEmailNotifier = {
      assertReady: () => undefined,
      sendMessage: async (message) => {
        if (emailMode === "fail") throw Object.assign(new Error("sensitive provider detail"), { code: "api_error" });
        sentMessages.push(message);
        return { messageId: `message-${sentMessages.length}` };
      },
    };
    const tsa = new Rfc3161TimestampClient({
      url: "https://tsa.example/tsr",
      nonceFactory: () => NONCE,
      fetchImpl: async (_url, init) => {
        const body = Buffer.from(init?.body as Uint8Array);
        tsaRequests.push(body);
        if (tsaMode === "down") throw new Error("ECONNREFUSED");
        // 要求 DER の末尾近くに imprint (OCTET STRING 32B) が入っている
        const imprintIndex = body.indexOf(Buffer.from([0x04, 0x20]));
        const imprintHex = body.subarray(imprintIndex + 2, imprintIndex + 34).toString("hex");
        return new Response(new Uint8Array(fakeTimestampResponse(imprintHex)), {
          status: 200, headers: { "content-type": "application/timestamp-reply" },
        });
      },
    });
    app = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: ORIGIN, roots: [root] },
      unsafeExposeInvoiceShareUrl: true,
      invoiceEmailNotifier: emailNotifier,
      evidenceTimestamp: tsa,
      logger: { warn: (fields, message) => { logWarnings.push({ fields, message }); } },
    });
    invoiceId = new InvoicesRepo(db).insert({
      issued_at: "2026-04-15", due_date: "2026-05-15", client: "Example", work_summary: "x", amount: 1000,
    });
    recipientId = new InvoiceDeliveryContactsRepo(db).insert({
      companyName: "Example Customer",
      email: "billing@example.com",
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function issueShare(): Promise<{ token: string; shareId: string; documentSha256: string }> {
    const res = await app.request(`/v1/invoices/${invoiceId}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath, recipient_id: recipientId }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { share_id: string; share_url: string; document_sha256: string };
    return {
      token: created.share_url.slice(created.share_url.lastIndexOf("/") + 1),
      shareId: created.share_id,
      documentSha256: created.document_sha256,
    };
  }

  async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** OTP を通して enrollment grant を得る。 */
  async function passOtp(token: string): Promise<string> {
    const begin = await app.request(`/v1/invoices/share/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=accepted",
    });
    expect(begin.status).toBe(200);
    const challengeId = (await begin.text()).match(/name="challenge_id" value="([^"]+)"/)?.[1];
    const code = sentMessages.at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
    const confirm = await app.request(`/v1/invoices/share/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ challenge_id: challengeId!, code: code! }).toString(),
    });
    expect(confirm.status).toBe(200);
    const page = await confirm.text();
    expect(page).toContain("data-mode=\"enroll\"");
    expect(page).toContain("src=\"/v1/invoices/share/passkey.js\"");
    const grantId = page.match(/data-grant="([^"]+)"/)?.[1];
    expect(grantId).toBeTruthy();
    return grantId!;
  }

  async function enroll(token: string, grantId: string, authenticator: FakeAuthenticator) {
    const options = await postJson(`/v1/invoices/share/${token}/accept`, { phase: "passkey-options", purpose: "register", grant_id: grantId });
    expect(options.status).toBe(200);
    const { challenge_id, options: creation } = await options.json() as { challenge_id: string; options: { challenge: string; rp: { id?: string } } };
    const register = await postJson(`/v1/invoices/share/${token}/accept`, {
      phase: "passkey-register",
      grant_id: grantId,
      challenge_id,
      response: authenticator.register(creation, ORIGIN),
    });
    expect(register.status).toBe(201);
    return await register.json() as { passkey_id: string; public_key_sha256: string };
  }

  async function sign(token: string, authenticator: FakeAuthenticator, headers: Record<string, string> = {}) {
    const options = await postJson(`/v1/invoices/share/${token}/accept`, { phase: "passkey-options", purpose: "assert" });
    expect(options.status).toBe(200);
    const { challenge_id, options: request, statement } = await options.json() as {
      challenge_id: string; options: { challenge: string; rpId?: string }; statement: Record<string, unknown>;
    };
    const accept = await postJson(`/v1/invoices/share/${token}/accept`, {
      phase: "passkey-accept",
      challenge_id,
      response: authenticator.assert(request, ORIGIN),
    }, headers);
    return { accept, statement, challenge: request.challenge };
  }

  it("初回: OTP → パスキー登録 → 署名で合意、 証跡バンドルとタイムスタンプが残り、 控えメールが届く", async () => {
    const { token, shareId, documentSha256 } = await issueShare();
    const landing = await (await app.request(`/v1/invoices/share/${token}`)).text();
    expect(landing).toContain("メール確認へ進む");
    expect(landing).not.toContain("data-mode=\"accept\"");

    const grantId = await passOtp(token);
    // OTP 通過時点では合意は無い
    expect((await app.request(`/v1/invoices/${invoiceId}/share-links/${shareId}/acceptance`)).status).toBe(404);

    const authenticator = new FakeAuthenticator();
    const registered = await enroll(token, grantId, authenticator);
    expect(registered.public_key_sha256).toMatch(/^[0-9a-f]{64}$/);

    const { accept, statement, challenge } = await sign(token, authenticator, {
      "CF-Ray": "ray-1", "user-agent": "Passkey Test/1.0",
    });
    expect(accept.status).toBe(201);
    const accepted = await accept.json() as { timestamp_status: string; evidence_sha256: string };
    expect(accepted.timestamp_status).toBe("granted");
    expect(tsaRequests).toHaveLength(1);

    // challenge は statement の SHA-256 (statement は document hash を含む)
    expect(statement.document_sha256).toBe(documentSha256);
    expect(statement.share_id).toBe(shareId);
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(statement).sort(([a], [b]) => a < b ? -1 : 1)));
    expect(challenge).toBe(createHash("sha256").update(canonical).digest("base64url"));

    const audit = await (await app.request(`/v1/invoices/${invoiceId}/share-links/${shareId}/acceptance`)).json() as {
      acceptance: Record<string, unknown>;
    };
    expect(audit.acceptance).toMatchObject({
      authentication_method: "passkey",
      credential_id: authenticator.credentialIdB64url,
      public_key_sha256: registered.public_key_sha256,
      timestamp_status: "granted",
      timestamp_authority: "https://tsa.example/tsr",
      timestamp_token_present: true,
      cf_ray: "ray-1",
    });
    expect(audit.acceptance.timestamp_token).toBeUndefined();

    // 証跡バンドル: DB を見ずに署名を検証できる
    const evidence = await app.request(`/v1/invoices/share/${token}?view=evidence`);
    expect(evidence.status).toBe(200);
    const bundle = await evidence.json() as InvoiceAcceptanceEvidenceBundle;
    expect(bundle.credential.public_key_sha256).toBe(registered.public_key_sha256);
    expect(bundle.acceptance.document_sha256).toBe(documentSha256);
    expect(evidenceSha256OfBundle(bundle)).toBe(bundle.acceptance.evidence_sha256);
    const tamperedBundle = structuredClone(bundle);
    tamperedBundle.assertion.signature_b64url = `${tamperedBundle.assertion.signature_b64url}A`;
    expect(evidenceSha256OfBundle(tamperedBundle)).not.toBe(bundle.acceptance.evidence_sha256);
    expect(bundle.timestamp.status).toBe("granted");
    expect(bundle.timestamp.status === "granted" && Buffer.from(bundle.timestamp.token_der_b64, "base64")
      .includes(Buffer.from(bundle.acceptance.evidence_sha256, "hex"))).toBe(true);
    const clientData = Buffer.from(bundle.assertion.client_data_json_b64url, "base64url");
    expect(JSON.parse(clientData.toString()).challenge).toBe(challenge);
    const verifier = createVerify("SHA256");
    verifier.update(Buffer.concat([
      Buffer.from(bundle.assertion.authenticator_data_b64url, "base64url"),
      createHash("sha256").update(clientData).digest(),
    ]));
    expect(verifier.verify(bundle.credential.public_key_spki_pem, Buffer.from(bundle.assertion.signature_b64url, "base64url"))).toBe(true);

    // 控えメール (OTP 1 通 + 証跡 1 通)
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]?.to).toBe("billing@example.com");
    expect(sentMessages[1]?.attachments?.[0]?.filename).toMatch(/^invoice-acceptance-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(sentMessages[1]!.attachments![0]!.content.toString()).acceptance.evidence_sha256).toBe(accepted.evidence_sha256);

    // 発行者側の証跡エンドポイントと一致
    const issuerEvidence = await app.request(`/v1/invoices/${invoiceId}/share-links/${shareId}/acceptance/evidence`);
    expect(issuerEvidence.status).toBe(200);
    expect((await issuerEvidence.json() as { acceptance: { evidence_sha256: string } }).acceptance.evidence_sha256).toBe(accepted.evidence_sha256);

    // ランディングは合意済みに変わる
    const after = await (await app.request(`/v1/invoices/share/${token}`)).text();
    expect(after).toContain("請求内容への合意を記録しました");
    expect(after).toContain("view=evidence");

    // 合意済み share では新しい署名 challenge を発行しない
    const again = await postJson(`/v1/invoices/share/${token}/accept`, { phase: "passkey-options", purpose: "assert" });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toBe("already_accepted");
  });

  it("2 回目以降の請求: 登録済みパスキーで OTP 無しに合意できる", async () => {
    const first = await issueShare();
    const authenticator = new FakeAuthenticator();
    await enroll(first.token, await passOtp(first.token), authenticator);
    expect((await sign(first.token, authenticator)).accept.status).toBe(201);
    const mailsBefore = sentMessages.length;

    const second = await issueShare();
    const landing = await (await app.request(`/v1/invoices/share/${second.token}`)).text();
    expect(landing).toContain("data-mode=\"accept\"");
    expect(landing).toContain("src=\"/v1/invoices/share/passkey.js\"");
    expect(landing).not.toContain("メール確認へ進む");
    const { accept } = await sign(second.token, authenticator);
    expect(accept.status).toBe(201);
    // OTP メールは出ない。 証跡メールだけ 1 通
    expect(sentMessages.length).toBe(mailsBefore + 1);
    expect(sentMessages.at(-1)?.subject).toContain("合意の控え");
  });

  it("送信先メールを変更しても旧メールで登録したパスキーを新しい受領者へ持ち越さない", async () => {
    const oldIdentityShare = await issueShare();
    const authenticator = new FakeAuthenticator();
    await enroll(oldIdentityShare.token, await passOtp(oldIdentityShare.token), authenticator);
    new InvoiceDeliveryContactsRepo(db).update(recipientId, {
      companyName: "Example Customer",
      email: "new-billing@example.com",
    });

    const newIdentityShare = await issueShare();
    const landing = await (await app.request(`/v1/invoices/share/${newIdentityShare.token}`)).text();
    expect(landing).toContain("メール確認へ進む");
    expect(landing).not.toContain("data-mode=\"accept\"");
    const options = await postJson(
      `/v1/invoices/share/${newIdentityShare.token}/accept`, { phase: "passkey-options", purpose: "assert" },
    );
    expect(options.status).toBe(409);
    expect(await options.json()).toEqual({
      error: "no_passkey",
      message: "パスキーが登録されていません。メール確認から登録してください。",
    });
  });

  it("同じ share の並行署名でも合意・タイムスタンプ・証跡メールは 1 件だけ作る", async () => {
    const share = await issueShare();
    const authenticator = new FakeAuthenticator();
    await enroll(share.token, await passOtp(share.token), authenticator);
    const acceptPath = `/v1/invoices/share/${share.token}/accept`;
    const first = await (await postJson(acceptPath, { phase: "passkey-options", purpose: "assert" })).json() as {
      challenge_id: string; options: { challenge: string; rpId?: string };
    };
    const second = await (await postJson(acceptPath, { phase: "passkey-options", purpose: "assert" })).json() as typeof first;

    const responses = await Promise.all([
      postJson(acceptPath, {
        phase: "passkey-accept",
        challenge_id: first.challenge_id,
        response: authenticator.assert(first.options, ORIGIN),
      }),
      postJson(acceptPath, {
        phase: "passkey-accept",
        challenge_id: second.challenge_id,
        response: authenticator.assert(second.options, ORIGIN),
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(tsaRequests).toHaveLength(1);
    expect(sentMessages.filter((message) => message.subject.includes("合意の控え"))).toHaveLength(1);
  });

  it("改竄・他 share・期限切れ・未登録鍵・PDF 差し替え・失効済みは合意を作らない", async () => {
    const share = await issueShare();
    const authenticator = new FakeAuthenticator();
    await enroll(share.token, await passOtp(share.token), authenticator);

    // 署名改竄
    let options = await (await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as { challenge_id: string; options: { challenge: string } };
    let res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept",
      challenge_id: options.challenge_id, response: authenticator.assert(options.options, ORIGIN, { tamperSignature: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("verification_failed");

    // 別 origin
    options = await (await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as typeof options;
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept",
      challenge_id: options.challenge_id, response: authenticator.assert(options.options, "https://evil.example.com"),
    });
    expect(res.status).toBe(400);

    // challenge を別の値にすり替え (statement に紐づかない)
    options = await (await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as typeof options;
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept",
      challenge_id: options.challenge_id,
      response: authenticator.assert(options.options, ORIGIN, { challenge: Buffer.alloc(32, 1).toString("base64url") }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_challenge");

    // 同じ challenge の再利用
    options = await (await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as typeof options;
    const assertion = authenticator.assert(options.options, ORIGIN, { tamperSignature: true });
    await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept", challenge_id: options.challenge_id, response: assertion });
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept", challenge_id: options.challenge_id, response: authenticator.assert(options.options, ORIGIN) });
    expect(res.status).toBe(400);

    // 未登録の認証器
    options = await (await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as typeof options;
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept",
      challenge_id: options.challenge_id, response: new FakeAuthenticator().assert(options.options, ORIGIN),
    });
    expect(res.status).toBe(404);

    // 他 share の challenge
    const other = await issueShare();
    options = await (await postJson(`/v1/invoices/share/${other.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as typeof options;
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept",
      challenge_id: options.challenge_id, response: authenticator.assert(options.options, ORIGIN),
    });
    expect(res.status).toBe(400);

    // PDF 差し替え → 409、 合意なし
    options = await (await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" })).json() as typeof options;
    writeFileSync(pdfPath, Buffer.concat([PDF, Buffer.from("tampered")]));
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, {
      phase: "passkey-accept",
      challenge_id: options.challenge_id, response: authenticator.assert(options.options, ORIGIN),
    });
    expect(res.status).toBe(409);
    writeFileSync(pdfPath, PDF);
    expect((await app.request(`/v1/invoices/${invoiceId}/share-links/${share.shareId}/acceptance`)).status).toBe(404);

    // 失効したパスキーは使えず、 ランディングは登録フローに戻る
    const passkeys = await (await app.request(`/v1/invoice-delivery-contacts/${recipientId}/passkeys`)).json() as { items: { id: string; revoked_at: number | null }[] };
    expect(passkeys.items).toHaveLength(1);
    const crossSiteRevoke = await app.request(
      `/v1/invoice-delivery-contacts/${recipientId}/passkeys/${passkeys.items[0]!.id}/revoke`,
      { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } },
    );
    expect(crossSiteRevoke.status).toBe(403);
    const revoke = await app.request(`/v1/invoice-delivery-contacts/${recipientId}/passkeys/${passkeys.items[0]!.id}/revoke`, { method: "POST" });
    expect(revoke.status).toBe(200);
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "assert" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("no_passkey");
    expect(await (await app.request(`/v1/invoices/share/${share.token}`)).text()).toContain("メール確認へ進む");
  }, 10_000);

  it("grant は 1 回限りで、 OTP 未通過では登録できない", async () => {
    const share = await issueShare();
    const authenticator = new FakeAuthenticator();
    // 偽の grant
    let res = await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "register", grant_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(403);

    const grantId = await passOtp(share.token);
    await enroll(share.token, grantId, authenticator);
    // 同じ grant で 2 本目は不可
    res = await postJson(`/v1/invoices/share/${share.token}/accept`, { phase: "passkey-options", purpose: "register", grant_id: grantId });
    expect(res.status).toBe(403);
  });

  it("タイムスタンプ局が落ちていても合意は成立し、 pending のまま再試行で granted になる", async () => {
    tsaMode = "down";
    const share = await issueShare();
    const authenticator = new FakeAuthenticator();
    await enroll(share.token, await passOtp(share.token), authenticator);
    const { accept } = await sign(share.token, authenticator);
    expect(accept.status).toBe(201);
    expect((await accept.json() as { timestamp_status: string }).timestamp_status).toBe("pending");
    expect(logWarnings).toContainEqual({
      fields: expect.objectContaining({ event: "invoice_evidence_timestamp_failed", errorCode: "transport" }),
      message: "invoice evidence timestamp failed",
    });
    const bundle = await (await app.request(`/v1/invoices/share/${share.token}?view=evidence`)).json() as { timestamp: { status: string } };
    expect(bundle.timestamp.status).toBe("pending");
    // 控えメールは pending の旨を含んで送られている
    expect(sentMessages.at(-1)?.text).toContain("後追い");

    tsaMode = "granted";
    const { EvidenceTimestampService } = await import("../src/services/evidence-timestamp-service.js");
    const { InvoiceShareAcceptanceRepo } = await import("../src/db/invoice-share-acceptance-repo.js");
    const service = new EvidenceTimestampService({
      acceptances: new InvoiceShareAcceptanceRepo(db),
      client: new Rfc3161TimestampClient({
        url: "https://tsa.example/tsr", nonceFactory: () => NONCE,
        fetchImpl: async (_url, init) => {
          const body = Buffer.from(init?.body as Uint8Array);
          const i = body.indexOf(Buffer.from([0x04, 0x20]));
          return new Response(new Uint8Array(fakeTimestampResponse(body.subarray(i + 2, i + 34).toString("hex"))), { status: 200 });
        },
      }),
    });
    expect(await service.retryPending()).toEqual({ attempted: 1, granted: 1 });
    expect(await service.retryPending()).toEqual({ attempted: 0, granted: 0 });
    const after = await (await app.request(`/v1/invoices/share/${share.token}?view=evidence`)).json() as { timestamp: { status: string } };
    expect(after.timestamp.status).toBe("granted");
  });

  it("証跡メール失敗は合意を取り消さず、個人データを含めずに観測できる", async () => {
    const share = await issueShare();
    const authenticator = new FakeAuthenticator();
    await enroll(share.token, await passOtp(share.token), authenticator);
    emailMode = "fail";

    const { accept } = await sign(share.token, authenticator);
    expect(accept.status).toBe(201);
    expect(logWarnings).toContainEqual({
      fields: {
        event: "invoice_evidence_mail_failed",
        shareId: share.shareId,
        errorCode: "api_error",
      },
      message: "invoice evidence mail failed",
    });
    expect(JSON.stringify(logWarnings)).not.toContain("sensitive provider detail");
    expect(JSON.stringify(logWarnings)).not.toContain("billing@example.com");
  });

  it("送信先台帳に紐づかないリンクは合意できない旨を表示し、 パスキー API は 400", async () => {
    const res = await app.request(`/v1/invoices/${invoiceId}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath }),
    });
    const created = await res.json() as { share_url: string };
    const token = created.share_url.slice(created.share_url.lastIndexOf("/") + 1);
    expect(await (await app.request(`/v1/invoices/share/${token}`)).text()).toContain("送信先台帳に紐づいていない");
    const options = await postJson(`/v1/invoices/share/${token}/accept`, { phase: "passkey-options", purpose: "assert" });
    expect(options.status).toBe(400);
  });

  it("スクリプトは share/ 直下 1 階層で配信し、 階層を挟むパスでは配信しない", async () => {
    // 公開経路の Cloudflare ingress は share/ の下 1 階層しか通さない。 階層を挟むと
    // ページは表示されるのにスクリプトだけ 404 になり、 ボタンが無反応になる。
    expect((await app.request("/v1/invoices/share/passkey.js")).status).toBe(200);
    expect((await app.request("/v1/invoices/share/assets/passkey.js")).status).toBe(404);
  });

  it("スクリプトのパスは token として解釈されない (ルート登録順)", async () => {
    const script = await app.request("/v1/invoices/share/passkey.js");
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  it("パスキー用スクリプトは同一 origin 配信で、 公開ページの CSP が script-src 'self' を許す", async () => {
    const script = await app.request("/v1/invoices/share/passkey.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("navigator.credentials");
    const share = await issueShare();
    const landing = await app.request(`/v1/invoices/share/${share.token}`);
    expect(landing.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(landing.headers.get("content-security-policy")).toContain("connect-src 'self'");
  });
});

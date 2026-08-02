import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GmailAdcClient } from "../src/services/gmail-adc-client.js";
import { InvoiceEmailError } from "../src/services/invoice-email-notifier.js";

const ADC = {
  type: "authorized_user",
  client_id: "test-client-id",
  client_secret: "test-client-secret",
  refresh_token: "test-refresh-token",
};

interface Call {
  url: string;
  init: { body?: unknown; headers?: Record<string, string> };
}

/** 投げられた InvoiceEmailError を code/status ごと検査するために取り出す。 */
async function emailError(run: () => unknown): Promise<InvoiceEmailError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvoiceEmailError);
    return error as InvoiceEmailError;
  }
  throw new Error("expected an InvoiceEmailError");
}

describe("GmailAdcClient", () => {
  let dir: string;
  let credentialsFile: string;
  let calls: Call[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quaestor-adc-"));
    credentialsFile = join(dir, "application_default_credentials.json");
    writeFileSync(credentialsFile, JSON.stringify(ADC));
    calls = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function client(responder: (call: Call) => Response): GmailAdcClient {
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const call = { url: String(url), init: (init ?? {}) as Call["init"] };
      calls.push(call);
      return responder(call);
    }) as unknown as typeof fetch;
    return new GmailAdcClient({ credentialsFile, fetchImpl, now: () => 1_000 });
  }

  function happyResponder(call: Call): Response {
    return call.url.includes("oauth2")
      ? new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ id: "gmail-message-1" }), { status: 200 });
  }

  function sentMime(): string {
    const send = calls.find((call) => call.url.includes("gmail.googleapis.com"));
    const body = JSON.parse(String(send?.init.body)) as { raw: string };
    return Buffer.from(body.raw, "base64url").toString("utf8");
  }

  it("ADC が無い / service_account / 壊れた JSON なら送信前に not_configured で止まる", async () => {
    const missing = new GmailAdcClient({ credentialsFile: join(dir, "absent.json") });
    expect((await emailError(() => missing.assertReady())).status).toBe(503);

    writeFileSync(credentialsFile, JSON.stringify({ type: "service_account", client_email: "x@y.z" }));
    const serviceAccount = await emailError(() => client(happyResponder).assertReady());
    expect(serviceAccount.code).toBe("not_configured");

    writeFileSync(credentialsFile, "{ not json");
    expect((await emailError(() => client(happyResponder).assertReady())).code).toBe("not_configured");
  });

  it("refresh token で access token を取り、UTF-8 の件名と本文を RFC 2047/base64 で送る", async () => {
    const result = await client(happyResponder).sendMessage({
      to: "billing@example.com",
      subject: "【Qs】請求内容への合意確認コード",
      text: "確認コード\n123456",
    });
    expect(result).toEqual({ messageId: "gmail-message-1" });

    const [tokenCall, sendCall] = calls;
    expect(tokenCall?.url).toBe("https://oauth2.googleapis.com/token");
    expect(String(tokenCall?.init.body)).toContain("grant_type=refresh_token");
    expect(sendCall?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(sendCall?.init.headers?.authorization).toBe("Bearer token-1");

    const mime = sentMime();
    const headers = mime.slice(0, mime.indexOf("\r\n\r\n"));
    expect(headers).toContain("To: billing@example.com");
    expect(headers).toContain("Content-Transfer-Encoding: base64");
    // 件名は encoded-word 化され、生の日本語が MIME ヘッダへ出ない。
    expect(headers).toContain("=?UTF-8?B?");
    expect(headers).not.toContain("請求内容");
    const body = mime.slice(mime.indexOf("\r\n\r\n") + 4).replaceAll("\r\n", "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("確認コード\n123456");
  });

  it("件名の改行を潰してヘッダ注入を防ぎ、宛先が不正なら送信しない", async () => {
    await client(happyResponder).sendMessage({
      to: "billing@example.com",
      subject: "件名\r\nBcc: attacker@example.net",
      text: "本文",
    });
    const headers = sentMime().slice(0, sentMime().indexOf("\r\n\r\n"));
    expect(headers).not.toContain("Bcc:");
    expect(headers.split("\r\n").filter((line) => line.startsWith("To: "))).toHaveLength(1);

    calls = [];
    const injected = await emailError(() => client(happyResponder).sendMessage({
      to: "victim@example.com\r\nBcc: attacker@example.net",
      subject: "件名",
      text: "本文",
    }));
    expect(injected.code).toBe("api_error");
    expect(calls.filter((call) => call.url.includes("gmail.googleapis.com"))).toHaveLength(0);
  });

  it("有効な access token は再利用し、認証と送信の失敗を区別して上げる", async () => {
    const reusing = client(happyResponder);
    await reusing.sendMessage({ to: "a@example.com", subject: "s", text: "t" });
    await reusing.sendMessage({ to: "a@example.com", subject: "s", text: "t" });
    expect(calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(1);

    const sendFailure = await emailError(() => client((call) => (call.url.includes("oauth2")
      ? new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: "backendError" }), { status: 500 })))
      .sendMessage({ to: "a@example.com", subject: "s", text: "t" }));
    expect(sendFailure).toMatchObject({ code: "api_error", status: 502 });

    const authFailure = await emailError(() => client(
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ).sendMessage({ to: "a@example.com", subject: "s", text: "t" }));
    expect(authFailure).toMatchObject({ code: "authentication_failed", status: 502 });
  });
});

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SesEmailClient, sesCredentialsFromEnv, signRequest } from "../src/services/ses-email-client.js";
import { InvoiceEmailError } from "../src/services/invoice-email-notifier.js";

const NOW = () => new Date("2026-08-18T03:04:05.000Z");
const REGION = "ap-northeast-1";
const FROM_ADDRESS = "invoice@example.com";
const CREDENTIALS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };

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

function client(
  responder: (call: Call) => Response,
  calls: Call[],
  overrides: Partial<{
    region: string;
    fromAddress: string;
    configurationSet: string;
    credentials: typeof CREDENTIALS & { sessionToken?: string };
  }> = {},
): SesEmailClient {
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: (init ?? {}) as Call["init"] };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return new SesEmailClient({
    region: overrides.region ?? REGION,
    fromAddress: overrides.fromAddress ?? FROM_ADDRESS,
    configurationSet: overrides.configurationSet,
    credentials: overrides.credentials ?? CREDENTIALS,
    fetchImpl,
    now: NOW,
  });
}

function happyResponder(): Response {
  return new Response(JSON.stringify({ MessageId: "ses-message-1" }), { status: 200 });
}

describe("SesEmailClient", () => {
  it("region / fromAddress / credentials のいずれか欠落は送信前に not_configured で止まる", async () => {
    const calls: Call[] = [];

    const noRegion = client(happyResponder, calls, { region: "" });
    expect((await emailError(() => noRegion.assertReady())).status).toBe(503);
    expect((await emailError(() => noRegion.assertReady())).code).toBe("not_configured");

    const noFrom = client(happyResponder, calls, { fromAddress: "" });
    expect((await emailError(() => noFrom.assertReady())).code).toBe("not_configured");

    const noCreds = new SesEmailClient({ region: REGION, fromAddress: FROM_ADDRESS, now: NOW });
    expect((await emailError(() => noCreds.assertReady())).code).toBe("not_configured");

    expect(calls).toHaveLength(0);
  });

  it("型が崩れた設定値も送信前に not_configured で閉じる", async () => {
    const malformed = new SesEmailClient({
      region: {} as unknown as string,
      fromAddress: FROM_ADDRESS,
      credentials: CREDENTIALS,
      now: NOW,
    });

    expect(await emailError(() => malformed.assertReady())).toMatchObject({
      code: "not_configured",
      status: 503,
    });
  });

  it("happy path: URL / body / SigV4 ヘッダを組み立てて送信する", async () => {
    const calls: Call[] = [];
    const result = await client(happyResponder, calls).sendMessage({
      to: "billing@example.com",
      subject: "件名",
      text: "本文",
    });
    expect(result).toEqual({ messageId: "ses-message-1" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails");

    const body = JSON.parse(String(call.init.body));
    expect(body.FromEmailAddress).toBe(FROM_ADDRESS);
    expect(body.Destination.ToAddresses).toEqual(["billing@example.com"]);
    expect(body.Content.Simple.Subject.Data).toBe("件名");
    expect(body.Content.Simple.Body.Text.Data).toBe("本文");
    expect(body).not.toHaveProperty("ConfigurationSetName");

    const headers = call.init.headers ?? {};
    expect(headers["x-amz-date"]).toBe("20260818T030405Z");
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(String(call.init.body), "utf8").digest("hex"));
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260818\/ap-northeast-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("添付がある場合は Simple ではなく Raw (MIME multipart, base64) で送る", async () => {
    const calls: Call[] = [];
    await client(happyResponder, calls).sendMessage({
      to: "billing@example.com",
      subject: "合意の控え",
      text: "本文\n2行目",
      attachments: [{ filename: "invoice-acceptance-1234abcd.json", contentType: "application/json", content: Buffer.from('{"a":1}') }],
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.Content).not.toHaveProperty("Simple");
    const mime = Buffer.from(body.Content.Raw.Data, "base64").toString("utf8");
    expect(mime).toContain(`From: ${FROM_ADDRESS}\r\n`);
    expect(mime).toContain("To: billing@example.com\r\n");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("合意の控え").toString("base64")}?=\r\n`);
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="qs-[0-9a-f]{24}"/);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from("本文\n2行目").toString("base64"));
    expect(mime).toContain('Content-Disposition: attachment; filename="invoice-acceptance-1234abcd.json"');
    expect(mime).toContain(Buffer.from('{"a":1}').toString("base64"));
    expect(mime.trimEnd().endsWith("--")).toBe(true);
  });

  it("configurationSet 指定時は body に含み、sessionToken 指定時は署名ヘッダへ含める", async () => {
    const calls: Call[] = [];
    await client(happyResponder, calls, { configurationSet: "invoice-set" }).sendMessage({
      to: "billing@example.com",
      subject: "件名",
      text: "本文",
    });
    const withSet = JSON.parse(String(calls[0]?.init.body));
    expect(withSet.ConfigurationSetName).toBe("invoice-set");

    calls.length = 0;
    await client(happyResponder, calls, {
      credentials: { ...CREDENTIALS, sessionToken: "session-token-1" },
    }).sendMessage({ to: "billing@example.com", subject: "件名", text: "本文" });
    const headers = calls[0]?.init.headers ?? {};
    expect(headers["x-amz-security-token"]).toBe("session-token-1");
    expect(headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
  });

  it("認証拒否は authentication_failed 502、それ以外の失敗は api_error 502で、資格情報や本文を含まない", async () => {
    const calls: Call[] = [];
    const forbidden = await emailError(() => client(
      () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
      calls,
    ).sendMessage({ to: "billing@example.com", subject: "件名", text: "本文" }));
    expect(forbidden).toMatchObject({ code: "authentication_failed", status: 502 });
    expect(forbidden.message).not.toContain("secret");
    expect(forbidden.message).not.toContain("本文");
    expect(forbidden.message).not.toContain("billing@example.com");

    const unauthorized = await emailError(() => client(
      () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
      calls,
    ).sendMessage({ to: "billing@example.com", subject: "件名", text: "本文" }));
    expect(unauthorized).toMatchObject({ code: "authentication_failed", status: 502 });

    const serverError = await emailError(() => client(
      () => new Response(JSON.stringify({ message: "backendError" }), { status: 500 }),
      calls,
    ).sendMessage({ to: "billing@example.com", subject: "件名", text: "本文" }));
    expect(serverError).toMatchObject({ code: "api_error", status: 502 });

    const noMessageId = await emailError(() => client(
      () => new Response(JSON.stringify({}), { status: 200 }),
      calls,
    ).sendMessage({ to: "billing@example.com", subject: "件名", text: "本文" }));
    expect(noMessageId).toMatchObject({ code: "api_error", status: 502 });

    const fetchRejects = await emailError(() => client(
      () => { throw new Error("network down"); },
      calls,
    ).sendMessage({ to: "billing@example.com", subject: "件名", text: "本文" }));
    expect(fetchRejects).toMatchObject({ code: "api_error", status: 502 });
    expect(fetchRejects.message).not.toContain("secret");
  });

  it("signRequest は同じ入力から決定的な署名を返す", () => {
    const url = new URL("https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails");
    const input = { method: "POST" as const, url, body: "{}", region: REGION, credentials: CREDENTIALS, now: NOW() };
    const first = signRequest(input);
    const second = signRequest(input);
    expect(first.authorization).toBe(second.authorization);
  });

  it("宛先が不正 (形式違反/改行混入) なら api_error 502 で fetch しない", async () => {
    const calls: Call[] = [];
    const invalidFormat = await emailError(() => client(happyResponder, calls).sendMessage({
      to: "bad",
      subject: "件名",
      text: "本文",
    }));
    expect(invalidFormat).toMatchObject({ code: "api_error", status: 502 });

    const injected = await emailError(() => client(happyResponder, calls).sendMessage({
      to: "victim@example.com\r\nBcc: attacker@example.net",
      subject: "件名",
      text: "本文",
    }));
    expect(injected).toMatchObject({ code: "api_error", status: 502 });

    expect(calls).toHaveLength(0);
  });

  it("sesCredentialsFromEnv: キー欠落は undefined、両方あれば object を返し、空白は trim、sessionToken は任意", () => {
    expect(sesCredentialsFromEnv({})).toBeUndefined();
    expect(sesCredentialsFromEnv({ QUAESTOR_SES_ACCESS_KEY_ID: "AKIA1" })).toBeUndefined();
    expect(sesCredentialsFromEnv({ QUAESTOR_SES_SECRET_ACCESS_KEY: "s3cr3t" })).toBeUndefined();

    expect(sesCredentialsFromEnv({
      QUAESTOR_SES_ACCESS_KEY_ID: " AKIA1 ",
      QUAESTOR_SES_SECRET_ACCESS_KEY: " s3cr3t ",
    })).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "s3cr3t" });

    expect(sesCredentialsFromEnv({
      QUAESTOR_SES_ACCESS_KEY_ID: "AKIA1",
      QUAESTOR_SES_SECRET_ACCESS_KEY: "s3cr3t",
      QUAESTOR_SES_SESSION_TOKEN: " token-1 ",
    })).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "s3cr3t", sessionToken: "token-1" });
  });
});

/**
 * Amazon SES (SESv2 `SendEmail`) の送信専用クライアント。
 *
 * SES は送信済み本文を保持しないので、運用者が「送信済みボックス」からマジックリンクや
 * 本文を事後に読み返す経路が存在しない。 資格情報は Qs 専用の送信専用 IAM キーであり、
 * 運用者個人の AWS プロファイル (`AWS_ACCESS_KEY_ID` 等) は読まない。
 *
 * SDK 依存を増やさず、 SigV4 署名を `node:crypto` で行い `fetch` で送る。
 *
 * @implements SPEC-INVOICE-EMAIL-001 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, createHmac } from "node:crypto";
import {
  InvoiceEmailError,
  type InvoiceEmailMessage,
  type InvoiceEmailNotifier,
  type InvoiceEmailSendResult,
} from "./invoice-email-notifier.js";

export interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SesEmailClientOptions {
  /** SES リージョン (例 `ap-northeast-1`)。 */
  region?: string;
  /** 検証済み ID から送る From アドレス。 表示名を含めない生アドレス。 */
  fromAddress?: string;
  /** 任意。 イベント発行やレピュテーション用の configuration set 名。 */
  configurationSet?: string;
  credentials?: SesCredentials;
  fetchImpl?: typeof fetch;
  /** 署名時刻 (テスト固定用)。 */
  now?: () => Date;
}

interface SesSendResponse {
  MessageId?: string;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** SigV4 署名付きで SESv2 SendEmail を呼ぶ送信専用クライアント。 資格情報や本文をエラーへ含めない。 */
export class SesEmailClient implements InvoiceEmailNotifier {
  private readonly region: string | undefined;
  private readonly fromAddress: string | undefined;
  private readonly configurationSet: string | undefined;
  private readonly credentials: SesCredentials | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: SesEmailClientOptions = {}) {
    this.region = trimOrUndefined(options.region);
    this.fromAddress = trimOrUndefined(options.fromAddress);
    this.configurationSet = trimOrUndefined(options.configurationSet);
    this.credentials = normalizeCredentials(options.credentials);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  assertReady(): void {
    this.settings();
  }

  async sendMessage(message: InvoiceEmailMessage): Promise<InvoiceEmailSendResult> {
    const settings = this.settings();
    if (!EMAIL.test(message.to) || /[\r\n]/.test(message.to)) {
      throw new InvoiceEmailError("api_error", "recipient email is invalid", 502);
    }
    const body = JSON.stringify({
      FromEmailAddress: settings.fromAddress,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: stripHeaderBreaks(message.subject), Charset: "UTF-8" },
          Body: { Text: { Data: message.text, Charset: "UTF-8" } },
        },
      },
      ...(settings.configurationSet ? { ConfigurationSetName: settings.configurationSet } : {}),
    });
    const url = new URL("/v2/email/outbound-emails", settings.endpoint);
    const headers = signRequest({
      method: "POST",
      url,
      body,
      region: settings.region,
      credentials: settings.credentials,
      now: this.now(),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "POST", headers, body });
    } catch {
      throw new InvoiceEmailError("api_error", "SES message delivery failed", 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new InvoiceEmailError("authentication_failed", "SES authentication failed", 502);
    }
    const payload = await response.json().catch(() => null) as SesSendResponse | null;
    if (!response.ok || !payload?.MessageId) {
      throw new InvoiceEmailError("api_error", "SES message delivery failed", 502);
    }
    return { messageId: payload.MessageId };
  }

  private settings(): {
    region: string;
    fromAddress: string;
    configurationSet: string | undefined;
    credentials: SesCredentials;
    endpoint: string;
  } {
    if (!this.region || !REGION.test(this.region)) {
      throw new InvoiceEmailError("not_configured", "SES region is not configured", 503);
    }
    if (!this.fromAddress || !EMAIL.test(this.fromAddress) || /[\r\n<>]/.test(this.fromAddress)) {
      throw new InvoiceEmailError("not_configured", "SES from address is not configured", 503);
    }
    if (!this.credentials) {
      throw new InvoiceEmailError("not_configured", "SES credentials are not configured", 503);
    }
    return {
      region: this.region,
      fromAddress: this.fromAddress,
      configurationSet: this.configurationSet,
      credentials: this.credentials,
      endpoint: `https://email.${this.region}.amazonaws.com`,
    };
  }
}

/** 暗号化ストアから env 注入された Qs 専用の送信専用キーを読む。 個人の AWS プロファイルは見ない。 */
export function sesCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): SesCredentials | undefined {
  return normalizeCredentials({
    accessKeyId: env.QUAESTOR_SES_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.QUAESTOR_SES_SECRET_ACCESS_KEY ?? "",
    sessionToken: env.QUAESTOR_SES_SESSION_TOKEN,
  });
}

function normalizeCredentials(value: SesCredentials | undefined): SesCredentials | undefined {
  if (!value) return undefined;
  const accessKeyId = value.accessKeyId?.trim();
  const secretAccessKey = value.secretAccessKey?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = trimOrUndefined(value.sessionToken);
  return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

interface SignInput {
  method: "POST";
  url: URL;
  body: string;
  region: string;
  credentials: SesCredentials;
  now: Date;
}

const SERVICE = "ses";

/** SESv2 REST 呼び出し用の SigV4 ヘッダを組み立てる。 署名対象は host / content-type / x-amz-* 。 */
export function signRequest(input: SignInput): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${(headers[name] ?? "").trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    input.method,
    canonicalUri(input.url.pathname),
    "", // query string なし
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const { host: _host, ...outgoing } = headers;
  return {
    ...outgoing,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/") || "/";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

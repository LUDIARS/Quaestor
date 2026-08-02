/**
 * Gmail API の送信専用クライアント。gcloud CLI が作成した authorized_user ADC を利用する。
 *
 * @implements SPEC-INVOICE-EMAIL-001 (spec/feature/invoice-public-magic-link.md)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  InvoiceEmailError,
  type InvoiceEmailMessage,
  type InvoiceEmailNotifier,
  type InvoiceEmailSendResult,
} from "./invoice-email-notifier.js";

interface AuthorizedUserAdc {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface GmailSendResponse {
  id?: string;
}

export interface GmailAdcClientOptions {
  credentialsFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class GmailAdcClient implements InvoiceEmailNotifier {
  private readonly credentialsFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(options: GmailAdcClientOptions = {}) {
    this.credentialsFile = resolve(options.credentialsFile ?? adcPath());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  assertReady(): void {
    this.readCredentials();
  }

  async sendMessage(message: InvoiceEmailMessage): Promise<InvoiceEmailSendResult> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw: encodeMimeMessage(message) }),
      });
    } catch {
      throw new InvoiceEmailError("api_error", "Gmail message delivery failed", 502);
    }
    const payload = await response.json().catch(() => null) as GmailSendResponse | null;
    if (!response.ok || !payload?.id) {
      throw new InvoiceEmailError("api_error", "Gmail message delivery failed", 502);
    }
    return { messageId: payload.id };
  }

  private async accessToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAt > this.now() + 60) return cached.value;
    const credentials = this.readCredentials();
    let response: Response;
    try {
      response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token,
          grant_type: "refresh_token",
        }),
      });
    } catch {
      throw new InvoiceEmailError("authentication_failed", "Gmail ADC authentication failed", 502);
    }
    const payload = await response.json().catch(() => null) as TokenResponse | null;
    if (!response.ok || !payload?.access_token) {
      throw new InvoiceEmailError("authentication_failed", "Gmail ADC authentication failed", 502);
    }
    this.cachedToken = {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(60, payload.expires_in ?? 3600),
    };
    return payload.access_token;
  }

  private readCredentials(): AuthorizedUserAdc {
    if (!existsSync(this.credentialsFile)) {
      throw new InvoiceEmailError("not_configured", "Gmail ADC credentials were not found", 503);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.credentialsFile, "utf8"));
    } catch {
      throw new InvoiceEmailError("not_configured", "Gmail ADC credentials are invalid", 503);
    }
    if (!isAuthorizedUserAdc(parsed)) {
      throw new InvoiceEmailError("not_configured", "Gmail ADC must be authorized_user credentials", 503);
    }
    return parsed;
  }
}

function adcPath(): string {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicit) return explicit;
  return process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "gcloud", "application_default_credentials.json")
    : join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

function isAuthorizedUserAdc(value: unknown): value is AuthorizedUserAdc {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.type === "authorized_user"
    && typeof row.client_id === "string" && row.client_id.length > 0
    && typeof row.client_secret === "string" && row.client_secret.length > 0
    && typeof row.refresh_token === "string" && row.refresh_token.length > 0;
}

function encodeMimeMessage(message: InvoiceEmailMessage): string {
  if (!/^[^\s@]+@[^\s@]+$/.test(message.to) || /[\r\n]/.test(message.to)) {
    throw new InvoiceEmailError("api_error", "recipient email is invalid", 502);
  }
  const subject = encodeSubject(stripHeaderBreaks(message.subject));
  const mime = [
    `To: ${message.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(message.text, "utf8").toString("base64")),
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const character of value) {
    const candidate = chunk + character;
    if (chunk && Buffer.from(candidate, "utf8").toString("base64").length > 52) {
      words.push(encodedWord(chunk));
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) words.push(encodedWord(chunk));
  return words.join("\r\n ");
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

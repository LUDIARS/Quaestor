import { GmailSource, type GmailSourceOptions, type SearchOptions, type MailMessage } from "@ludiars/mail-inbox";
import { GmailRateLimit } from "./gmail-rate-limit.js";

export interface MailIdPage { ids: string[]; nextPageToken: string | null }
export interface MailIdSource { listIds(query: string, pageToken: string | null): Promise<MailIdPage> }

/** @implements SPEC-MAIL-CRAWLER-001 */
export class GmailCrawlSource extends GmailSource implements MailIdSource {
  private readonly options: GmailSourceOptions;
  private readonly lastLimit: () => GmailRateLimit | undefined;
  constructor(options: GmailSourceOptions) {
    let limit: GmailRateLimit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      try { return await (options.fetchImpl ?? fetch)(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }); }
      catch (error) { if (error instanceof GmailRateLimit) limit = error; throw error; }
    };
    super({ ...options, fetchImpl });
    this.options = { ...options, fetchImpl };
    this.lastLimit = () => limit;
  }
  override async get(id: string, opts?: Pick<SearchOptions, "loadAttachments" | "maxAttachmentBytes">): Promise<MailMessage | null> {
    try { return await super.get(id, opts); }
    catch (error) { const limit = this.lastLimit(); if (limit && limit.retryAt > Date.now()) throw limit; throw error; }
  }
  async listIds(query: string, pageToken: string | null): Promise<MailIdPage> {
    const params = new URLSearchParams({ q: query, maxResults: "10" });
    if (pageToken) params.set("pageToken", pageToken);
    const token = await this.options.auth.getAccessToken();
    const response = await (this.options.fetchImpl ?? fetch)(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`gmail_http_${response.status}`);
    const value = await response.json() as { messages?: { id?: unknown }[]; nextPageToken?: unknown };
    if ((value.messages !== undefined && !Array.isArray(value.messages))
      || value.messages?.some((item) => typeof item.id !== "string")
      || (value.nextPageToken !== undefined && typeof value.nextPageToken !== "string")) throw new Error("gmail_invalid_page");
    return { ids: (value.messages ?? []).map((item) => item.id as string), nextPageToken: value.nextPageToken as string ?? null };
  }
}

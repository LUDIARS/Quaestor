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
  override async loadAttachment(id: string, attachment: string): Promise<Buffer> {
    try { return await super.loadAttachment(id, attachment); }
    catch (error) { const limit = this.lastLimit(); if (limit && limit.retryAt > Date.now()) throw limit; throw error; }
  }
  async internalDate(id: string): Promise<number | null> {
    const params = new URLSearchParams({ format: "minimal", fields: "id,internalDate" });
    const response = await this.readMessages(`/${encodeURIComponent(id)}?${params}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("gmail_metadata_failed");
    const value = await response.json() as { id?: unknown; internalDate?: unknown } | null;
    if (value?.id !== id || typeof value.internalDate !== "string" || !/^\d+$/.test(value.internalDate)) return null;
    const ms = Number(value.internalDate);
    return Number.isSafeInteger(ms) ? ms : null;
  }
  async listIds(query: string, pageToken: string | null, verifyEmpty = false): Promise<MailIdPage> {
    const params = new URLSearchParams({ q: query, maxResults: "10" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await this.readMessages(`?${params}`);
    if (!response.ok) throw new Error(`gmail_http_${response.status}`);
    const value = await response.json() as { messages?: { id?: unknown }[]; nextPageToken?: unknown; resultSizeEstimate?: unknown };
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value.messages !== undefined && !Array.isArray(value.messages))
      || value.messages?.some((item) => !item || typeof item.id !== "string" || !item.id.trim())
      || (verifyEmpty && value.messages === undefined && value.nextPageToken === undefined && value.resultSizeEstimate !== 0)
      || (value.nextPageToken !== undefined && (typeof value.nextPageToken !== "string" || !value.nextPageToken.trim()))) {
      throw new Error("gmail_invalid_page");
    }
    return { ids: (value.messages ?? []).map((item) => item.id as string), nextPageToken: value.nextPageToken as string ?? null };
  }

  private async readMessages(suffix: string): Promise<Response> {
    const token = await this.options.auth.getAccessToken();
    const base = (this.options.baseUrl ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
    const url = `${base}/users/${encodeURIComponent(this.options.userId ?? "me")}/messages${suffix}`;
    return (this.options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  }
}

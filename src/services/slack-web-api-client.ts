/**
 * Slack Web API 送信専用クライアントと宛先解決。
 *
 * @implements SPEC-INVOICE-SLACK-003 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-SLACK-004 (spec/feature/invoice-public-magic-link.md)
 */

export type SlackInvoiceTarget =
  | { conversationId: string }
  | { userIds: string[] };

export interface SlackInvoiceMessage {
  target: SlackInvoiceTarget;
  text: string;
  blocks: Record<string, unknown>[];
}

export interface SlackPostResult {
  conversationId: string;
  messageTs: string;
}

export interface SlackInvoiceNotifier {
  assertReady(target: SlackInvoiceTarget): void;
  postMessage(message: SlackInvoiceMessage): Promise<SlackPostResult>;
}

export class SlackDeliveryError extends Error {
  constructor(
    readonly code: "not_configured" | "invalid_target" | "api_error",
    message: string,
    readonly status: 400 | 502 | 503,
  ) {
    super(message);
  }
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  channel?: { id?: string } | string;
  ts?: string;
}

export interface SlackWebApiClientOptions {
  botToken?: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

const CONVERSATION_ID = /^G[A-Z0-9]{2,}$/;
const USER_ID = /^[UW][A-Z0-9]{2,}$/;

/** Slack Web API の送信専用クライアント。トークンや本文をエラーへ含めない。 */
export class SlackWebApiClient implements SlackInvoiceNotifier {
  private readonly botToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(options: SlackWebApiClientOptions = {}) {
    this.botToken = options.botToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://slack.com/api").replace(/\/+$/, "");
  }

  assertReady(target: SlackInvoiceTarget): void {
    if (!this.botToken) {
      throw new SlackDeliveryError("not_configured", "Slack bot token is not configured", 503);
    }
    validateSlackInvoiceTarget(target);
  }

  async postMessage(message: SlackInvoiceMessage): Promise<SlackPostResult> {
    this.assertReady(message.target);
    const conversationId = "conversationId" in message.target
      ? message.target.conversationId
      : await this.openGroupDirectMessage(message.target.userIds);
    const posted = await this.call("chat.postMessage", {
      channel: conversationId,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!posted.ts) throw apiError("chat.postMessage", "missing_message_ts");
    return { conversationId, messageTs: posted.ts };
  }

  private async openGroupDirectMessage(userIds: string[]): Promise<string> {
    const opened = await this.call("conversations.open", { users: userIds.join(",") });
    const conversationId = typeof opened.channel === "string" ? opened.channel : opened.channel?.id;
    if (!conversationId || !CONVERSATION_ID.test(conversationId)) {
      throw apiError("conversations.open", "missing_group_conversation_id");
    }
    return conversationId;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    }).catch(() => {
      throw apiError(method, "network_error");
    });
    if (!response.ok) throw apiError(method, `http_${response.status}`);
    const payload = await response.json().catch(() => null) as SlackApiResponse | null;
    if (!payload?.ok) throw apiError(method, safeSlackError(payload?.error));
    return payload;
  }
}

export function resolveSlackInvoiceTarget(
  env: NodeJS.ProcessEnv = process.env,
): SlackInvoiceTarget | undefined {
  const conversationId = env.QUAESTOR_SLACK_CONVERSATION_ID?.trim();
  const userIds = env.QUAESTOR_SLACK_USER_IDS
    ?.split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  if (conversationId && userIds?.length) {
    throw new SlackDeliveryError(
      "invalid_target",
      "Configure either QUAESTOR_SLACK_CONVERSATION_ID or QUAESTOR_SLACK_USER_IDS, not both",
      400,
    );
  }
  const target = conversationId
    ? { conversationId }
    : userIds?.length ? { userIds } : undefined;
  if (target) validateSlackInvoiceTarget(target);
  return target;
}

export function validateSlackInvoiceTarget(target: SlackInvoiceTarget): void {
  if ("conversationId" in target) {
    if (!CONVERSATION_ID.test(target.conversationId)) {
      throw new SlackDeliveryError("invalid_target", "Slack group DM conversation ID must start with G", 400);
    }
    return;
  }
  const unique = new Set(target.userIds);
  if (
    target.userIds.length < 2
    || target.userIds.length > 8
    || unique.size !== target.userIds.length
    || target.userIds.some((id) => !USER_ID.test(id))
  ) {
    throw new SlackDeliveryError(
      "invalid_target",
      "Slack group DM requires 2 to 8 distinct user IDs starting with U or W",
      400,
    );
  }
}

function apiError(method: string, detail: string): SlackDeliveryError {
  return new SlackDeliveryError("api_error", `Slack ${method} failed: ${detail}`, 502);
}

function safeSlackError(value: string | undefined): string {
  return value && /^[a-z0-9_]+$/i.test(value) ? value : "unknown_error";
}

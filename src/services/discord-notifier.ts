/**
 * Discord Webhook 通知 (送信専用)。 アドバイザーのアドバイスを Discord に push する。
 *
 * Webhook URL はシークレット (secret-store の `QUAESTOR_DISCORD_WEBHOOK_URL`、 起動時に env 注入)。
 * 双方向は不要なので bot ではなく webhook を使う。 fetchImpl を DI してテストする。
 */

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface DiscordNotifier {
  /** 送信。 成功で true。 webhook 未設定なら送らず false */
  send(message: DiscordMessage): Promise<boolean>;
  readonly enabled: boolean;
}

export interface WebhookNotifierOptions {
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

export class WebhookDiscordNotifier implements DiscordNotifier {
  private readonly url: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WebhookNotifierOptions = {}) {
    this.url = opts.webhookUrl ?? process.env.QUAESTOR_DISCORD_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return !!this.url;
  }

  async send(message: DiscordMessage): Promise<boolean> {
    if (!this.url) return false;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    // Discord webhook は成功で 204 (no body)。 2xx を成功とみなす
    return res.ok;
  }
}

/** buildApp の resolve 用: webhook URL があれば notifier を返す */
export function resolveDiscordNotifier(
  opt: DiscordNotifier | "auto" | "disabled" | undefined,
): DiscordNotifier | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  const n = new WebhookDiscordNotifier();
  return n.enabled ? n : undefined;
}

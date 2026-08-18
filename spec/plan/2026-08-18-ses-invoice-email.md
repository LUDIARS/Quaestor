# 請求書メール送信元を Gmail ADC から Amazon SES へ置換する — 実装設計

- 日付: 2026-08-18
- 発案: neco (要件: 運用者が送信内容を読めない / 発行済みマジックリンクを特定できない)
- 対象 spec: `spec/feature/invoice-public-magic-link.md` (SPEC-INVOICE-EMAIL-001 改訂済),
  `spec/setup/config-and-secrets.md` §1 表 / §2 表 / §3 (改訂済)

## 1. 背景と決定

現行 `GmailAdcClient` は運用者の gcloud ADC (authorized_user refresh token) で送るため、 送った本文と
リンクが運用者の Gmail「送信済み」に永久保存され、 要件を満たさない。 Slack は投稿がサーバに残り、
bot に `im:history` を後付けすれば遡及的に読めるため匿名性が弱い。 Amazon SES は送信済み本文を
保持せず、 イベント発行にも本文が含まれないので、 事後に読み返す経路が構造的に無い。 → **SES を
唯一のメール経路にし、 Gmail ADC クライアントは削除する** (置換であってリネームではない)。

## 2. 変更ファイル一覧 (これ以外は触らない)

| 操作 | パス | 内容 |
|---|---|---|
| 新規 | `src/services/ses-email-client.ts` | §3 のコードをそのまま配置 |
| 削除 | `src/services/gmail-adc-client.ts` | Gmail 実装を削除 |
| 削除 | `tests/gmail-adc-client.test.ts` | Gmail テストを削除 |
| 新規 | `tests/ses-email-client.test.ts` | §5 のテスト |
| 変更 | `src/services/app-config.ts` | `invoiceShare.email` 設定を追加 (§4.1) |
| 変更 | `src/app.ts` | `resolveInvoiceEmailNotifier` を SES へ (§4.2) |
| 変更 | `src/server.ts` | コメント更新のみ (§4.3) |
| 変更 | `src/services/invoice-email-notifier.ts` | 先頭コメント「実装は Gmail ADC」→「実装は Amazon SES」 |
| 変更 | `src/services/invoice-email-delivery.ts` | コメント/エラーメッセージの「Gmail」→「SES」 (§4.4) |
| 変更 | `src/services/invoice-share-acceptance-service.ts` | エラーメッセージの「Gmail ADC」→「SES」 (§4.4) |
| 変更 | `tests/invoice-email-delivery.test.ts` | コメント中の「実 ADC の Gmail」を「実 SES」に (§4.4)。 ロジック不変 |
| 変更 | `tests/app-config.test.ts` | `invoiceShare.email` の既定/ファイル/env テスト追加 (§5.2) |
| 変更 | `README.md` / `DESIGN.md` | Gmail/ADC への言及があれば SES に置換 (grep で確認、無ければ変更なし) |

`package.json` に依存を **追加しない** (SigV4 は `node:crypto`)。 `web/` は触らない。

## 3. `src/services/ses-email-client.ts` (このまま配置する)

```ts
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
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join("");
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
```

## 4. 変更点の詳細

### 4.1 `src/services/app-config.ts`

`AppConfig["invoiceShare"]` に追加:

```ts
  invoiceShare: {
    publicUrl: string | null;
    roots: string[];
    /** 請求書メールの送信元 (Amazon SES)。 region/fromAddress が null ならメール送信不可 (503) */
    email: {
      region: string | null;
      fromAddress: string | null;
      configurationSet: string | null;
    };
  };
```

`DEFAULTS.invoiceShare` を `{ publicUrl: null, roots: [...], email: { region: null, fromAddress: null, configurationSet: null } }` に。
`loadAppConfig` の `invoiceShare` へ:

```ts
      email: {
        region:           strOrNull(env("QUAESTOR_SES_REGION"),            fromFile?.invoiceShare?.email?.region),
        fromAddress:      strOrNull(env("QUAESTOR_SES_FROM_ADDRESS"),      fromFile?.invoiceShare?.email?.fromAddress),
        configurationSet: strOrNull(env("QUAESTOR_SES_CONFIGURATION_SET"), fromFile?.invoiceShare?.email?.configurationSet),
      },
```

`PartialConfig.invoiceShare` を
`Partial<Omit<AppConfig["invoiceShare"], "email">> & { email?: Partial<AppConfig["invoiceShare"]["email"]> }` に。

### 4.2 `src/app.ts`

- `import { GmailAdcClient } from "./services/gmail-adc-client.js";` を削除し、
  `import { SesEmailClient, sesCredentialsFromEnv } from "./services/ses-email-client.js";` を追加。
- `AppDeps.invoiceShare` の型を `{ publicUrl?: string | null; roots?: string[]; email?: { region?: string | null; fromAddress?: string | null; configurationSet?: string | null } }` に広げる (既存テストの `invoiceShare: { publicUrl, roots }` はそのまま通る)。
- `AppDeps.invoiceEmailNotifier` の doc コメント (146 行付近) を「Amazon SES 送信。 `"auto"` を明示したときだけ暗号化ストア由来の送信専用キーで実クライアントを組み立てる」に。
- `resolveInvoiceEmailNotifier(value)` を `resolveInvoiceEmailNotifier(value, email)` に変え、 呼び出し側は `resolveInvoiceEmailNotifier(deps.invoiceEmailNotifier, deps.invoiceShare?.email)`:

```ts
/**
 * 実 SES 資格情報は本番の送信専用キーそのものなので、 `"auto"` の明示なしに本番クライアントを
 * 組み立てない。 省略時に組み立てると、 notifier 未注入のテストが暗号化ストア由来の env を読み、
 * fixture 宛の実メール送信へ到達しうる。 未設定時は各サービスが 503 not_configured を返す。
 *
 * @implements SPEC-INVOICE-EMAIL-001 (spec/feature/invoice-public-magic-link.md)
 */
function resolveInvoiceEmailNotifier(
  value: InvoiceEmailNotifier | "auto" | "disabled" | undefined,
  email: { region?: string | null; fromAddress?: string | null; configurationSet?: string | null } | undefined,
): InvoiceEmailNotifier | undefined {
  if (value === "auto") {
    return new SesEmailClient({
      region: email?.region ?? undefined,
      fromAddress: email?.fromAddress ?? undefined,
      configurationSet: email?.configurationSet ?? undefined,
      credentials: sesCredentialsFromEnv(),
    });
  }
  if (value && typeof value === "object") return value;
  return undefined;
}
```

### 4.3 `src/server.ts`

コメント「本番プロセスだけが実 ADC を読む Gmail クライアントを持つ。 ADC 未設定なら 503 not_configured。」→
「本番プロセスだけが暗号化ストア由来の送信専用キーで SES クライアントを持つ。 未設定なら 503 not_configured。」
`invoiceShare: config.invoiceShare` は既に渡しているので `email` は自動で届く。

### 4.4 文言置換 (ロジック不変)

- `invoice-email-delivery.ts`: 冒頭コメント「Gmail配信」→「SES配信」、 `"Gmail ADC is not configured"` → `"SES email is not configured"`
- `invoice-share-acceptance-service.ts`: `"Gmail ADC is not configured"` → `"SES email is not configured"`
- `invoice-email-notifier.ts`: 「実装は Gmail ADC」→「実装は Amazon SES」
- `tests/invoice-email-delivery.test.ts` 100 行付近のコメント「実 ADC の Gmail クライアント」→「実 SES クライアント」、 テスト名「実ADCへ fallback せず」→「実SESへ fallback せず」

## 5. テスト (書くだけ。 このセッションでは実行しない。 Revisor が回す)

### 5.1 `tests/ses-email-client.test.ts`

`tests/gmail-adc-client.test.ts` の構造 (fetchImpl 差し替え + `emailError` ヘルパ) を踏襲し、 以下を検証:

1. **設定欠落・型不正は 503**: region 無し / fromAddress 無し / credentials 無し、および設定ファイル由来の
   型不正な region がそれぞれ `assertReady()` で `InvoiceEmailError` code `not_configured` status 503。
   fetch は 0 回。
2. **送信 happy path**: `now: () => new Date("2026-08-18T03:04:05.000Z")` 固定、 region `ap-northeast-1`、
   fromAddress `invoice@example.com`、 credentials `{accessKeyId:"AKIAEXAMPLE", secretAccessKey:"secret"}`。
   `sendMessage({to:"billing@example.com", subject:"件名", text:"本文"})` で
   - URL が `https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails`
   - body JSON が `FromEmailAddress` / `Destination.ToAddresses[0]` / `Content.Simple.Subject.Data` /
     `Content.Simple.Body.Text.Data` を保持し、 `ConfigurationSetName` を含まない
   - headers に `x-amz-date: 20260818T030405Z`、 `x-amz-content-sha256` = body の sha256、
     `authorization` が `AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260818/ap-northeast-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=` で始まり 64 桁 hex で終わる
   - 戻り値 `{ messageId: "ses-message-1" }` (レスポンス `{"MessageId":"ses-message-1"}`)
3. **configurationSet 指定時**は body に `ConfigurationSetName` が入る。 sessionToken 指定時は
   `x-amz-security-token` ヘッダが付き `SignedHeaders` に `x-amz-security-token` が含まれる。
4. **401 / 403 は authentication_failed 502**、 500 / MessageId 無し / fetch reject は `api_error` 502。
   エラー message に secretAccessKey・本文・宛先が含まれない (`expect(error.message).not.toContain("secret")` 等)。
5. **署名の決定性**: `signRequest` を同じ入力で 2 回呼び、 `authorization` が一致する。
6. **宛先不正** (`"bad"`, 改行入り) は `api_error` 502 で fetch 0 回。
7. **`sesCredentialsFromEnv`**: キー欠落 → `undefined`、 両方あり → object、 空白 trim、 sessionToken 任意。

### 5.2 `tests/app-config.test.ts`

既存 `invoiceShare` テストに準じ: 既定で `email` が全 null、 ファイル指定で読める、 env
`QUAESTOR_SES_REGION` / `QUAESTOR_SES_FROM_ADDRESS` / `QUAESTOR_SES_CONFIGURATION_SET` がファイルより優先。

## 6. 完了チェック (機械判定・PR 説明へ結果を書く)

```
grep -rn -i "gmail\|GmailAdc\|application_default_credentials\|GOOGLE_APPLICATION_CREDENTIALS" src tests   # 0 件
test ! -e src/services/gmail-adc-client.ts && test ! -e tests/gmail-adc-client.test.ts                # 存在しない
grep -n "SesEmailClient" src/app.ts                                                                    # 2 件以上 (import + new)
grep -n "sesCredentialsFromEnv" src/app.ts src/services/ses-email-client.ts                            # 両方にあり
grep -n "AWS_ACCESS_KEY_ID\|AWS_SECRET_ACCESS_KEY\|AWS_PROFILE" src                                    # 0 件 (個人プロファイルを読まない)
grep -n "@aws-sdk" package.json                                                                        # 0 件
npx tsc --noEmit -p tsconfig.json                                                                     # 0 error
```

vitest の実行は Revisor に任せる (このセッションでは走らせない)。

## 7. やらないこと

- Slack 経路の変更 (別タスク)。
- token 生成の Lambda 外出し (フェーズ 2、 未着手)。
- `web/` の UI 変更。 メール送信 UI は既存 API のまま。
- 依存追加、 lockfile 変更。

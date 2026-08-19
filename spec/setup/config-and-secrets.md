# 設定とシークレットの管理 (AIFormat RULE.md §7 準拠)

Quaestor を動かすための設定の置き場所と渡し方。**env を手で立てる運用はしない。**

## 1. 非シークレット設定 — `quaestor.config.json` (リポ直下、コミット対象)

単一 loader `src/services/app-config.ts` が読む。env は **override 用** (既定値はファイル)。

| キー | 既定値 | 用途 (根拠) | env override |
|---|---|---|---|
| `server.host` | `127.0.0.1` | backend bind (server.ts) | `QUAESTOR_HOST` |
| `server.port` | `17400` | backend port (PORT-MAP) | `QUAESTOR_PORT` |
| `server.logLevel` | `info` | pino レベル (server.ts) | `QUAESTOR_LOG_LEVEL` |
| `storage.dbPath` | `app_data/quaestor.db` | SQLite 本体 (server.ts) | `QUAESTOR_DB` |
| `storage.receiptsRoot` | `app_data/receipts` | レシート画像 (server.ts) | `QUAESTOR_RECEIPTS_ROOT` |
| `ocrWorker.enabled` | `true` | LLM OCR worker 起動 (server.ts) | `QUAESTOR_OCR_WORKER` |
| `ocrWorker.intervalMs` | `30000` | OCR poll 間隔 (ocr-worker.ts) | `QUAESTOR_OCR_INTERVAL_MS` |
| `ocrSidecar.manage` | `true` | sidecar 同時起動 (supervisor) | `QUAESTOR_OCR_SIDECAR_MANAGE` |
| `ocrSidecar.host` / `port` | `127.0.0.1` / `17350` | sidecar bind (supervisor) | `QUAESTOR_OCR_SIDECAR_PORT` |
| `ocrSidecar.lang` | `japan` | PaddleOCR 言語 (main.py へ起動時注入) | `QUAESTOR_OCR_LANG` |
| `ocrSidecar.python` | `null` (= .venv 優先) | python 実行体 (supervisor) | `QUAESTOR_OCR_PYTHON` |
| `ocrSidecar.venvPython` | `null` (= 3.12→3.9 自動探索) | .venv を**作る** python (setup.ps1/sh)。paddlepaddle は 3.9-3.12 のみ wheel 提供 | — |
| `ocrSidecar.externalUrl` | `null` | 外部 sidecar 利用 (指定時は起動しない) | `QUAESTOR_OCR_SIDECAR_URL` |
| `training.gaRoot` | `app_data/training/ga` | OCR-GA 永続 + 学習ログ (ocr-ga.ts) | — |
| `invoiceShare.publicUrl` | `null` | 請求書マジックリンクの公開 HTTPS origin。 `null` = 発行不可 (503) | `QUAESTOR_PUBLIC_URL` |
| `invoiceShare.roots` | `["data","app_data/invoices"]` | 共有を許可する PDF ルート (invoice-share-service.ts) | `QUAESTOR_INVOICE_SHARE_ROOTS` (`;` 区切り) |
| `invoiceShare.email.region` | `null` | 請求書メールを送る Amazon SES リージョン (例 `ap-northeast-1`)。 `null` = メール送信不可 (503) | `QUAESTOR_SES_REGION` |
| `invoiceShare.email.fromAddress` | `null` | SES で検証済みドメイン上の送信元アドレス (表示名なし)。 `null` = メール送信不可 (503) | `QUAESTOR_SES_FROM_ADDRESS` |
| `invoiceShare.email.configurationSet` | `null` | 任意。 SES configuration set 名 (レピュテーション/配信イベント用。 本文は流れない) | `QUAESTOR_SES_CONFIGURATION_SET` |
| `invoiceShare.timestampAuthority.url` | `https://freetsa.org/tsr` | 合意証跡の SHA-256 を打刻する RFC 3161 タイムスタンプ局 (TSA) の URL | `QUAESTOR_TSA_URL` |
| `invoiceShare.timestampAuthority.enabled` | `true` | `false` で外部タイムスタンプを付けない (合意行の `timestamp_status` は `skipped`) | `QUAESTOR_TSA_ENABLED` |

web (ブラウザ) は `import.meta.env` を使わない。非シークレット設定は
`GET /v1/config` (app.ts) → `web/src/lib/runtime-config.ts` で受け取る。配備バージョンは
`GET /health` の `version` で取得する。

## 2. シークレット — 暗号化ストア (`app_data/secrets.enc.json`)

API キー等は **平文でファイル保存しない** (§7.2)。

- 保存: AES-256-GCM (AEAD)。鍵は本体と分離して `~/.quaestor/secret.key` (初回自動生成)。
- 登録: `npm run secret -- set ANTHROPIC_API_KEY sk-ant-xxxx`
- 標準入力から登録: `Get-Clipboard | npm run secret -- set-stdin NAME` (値をコマンド履歴・引数へ出さない)
- 確認: `npm run secret -- list` (参照名のみ。値は出さない)
- 削除: `npm run secret -- remove ANTHROPIC_API_KEY`
- 利用: backend 起動時に `SecretStore.injectIntoEnv()` が復号してプロセスメモリ
  (process.env) へ注入する。ディスクには平文を書かない。
  既に env で渡されているキーは env が優先 (ストアは fallback)。

### Quaestor が使うシークレット

| 参照名 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Vision OCR / 銘柄マッピング / 優待取得 / 差分 Opus 類推 |
| `QUAESTOR_SES_ACCESS_KEY_ID` | 請求書メール送信専用 IAM ユーザーのアクセスキー ID (`ses:SendEmail` のみ) |
| `QUAESTOR_SES_SECRET_ACCESS_KEY` | 同シークレットアクセスキー |
| `QUAESTOR_SES_SESSION_TOKEN` | 任意。 一時クレデンシャルを使う場合のセッショントークン |
| `QUAESTOR_SLACK_BOT_TOKEN` | 請求書マジックリンク投稿用 Slack Bot User OAuth Token (`xoxb-...`) |
| `QUAESTOR_SLACK_CONVERSATION_ID` | 既定の Slack グループ DM conversation ID (`G...`) |
| `QUAESTOR_SLACK_USER_IDS` | グループ DM を開く2〜8名の user ID (`U...` / `W...`) を `;` 区切りで指定 |
| `QUAESTOR_ACCEPTANCE_REFERENCE_LATITUDE` | 合意地点の補助判定に使う送信者側基準緯度。監査ログには保存しない |
| `QUAESTOR_ACCEPTANCE_REFERENCE_LONGITUDE` | 合意地点の補助判定に使う送信者側基準経度。監査ログには保存しない |
| `QUAESTOR_ACCEPTANCE_REFERENCE_RADIUS_KM` | 「近辺」とする半径 km。省略時 20 km、最大 1000 km |

Slack の宛先は `QUAESTOR_SLACK_CONVERSATION_ID` と `QUAESTOR_SLACK_USER_IDS` のどちらか
一方だけを登録する。両方ある場合は設定エラーとして起動時のアプリ組み立てを停止する。
PowerShell では、値をクリップボードへコピーして次のように登録するとトークンを履歴や
プロセス引数へ露出しない。

```powershell
Get-Clipboard | npm run secret -- set-stdin QUAESTOR_SLACK_BOT_TOKEN
Get-Clipboard | npm run secret -- set-stdin QUAESTOR_SLACK_CONVERSATION_ID
npm run secret -- list
```

合意地点の補助判定を有効にする場合は、Cloudflare Dashboard の **Rules > Transform Rules >
Managed Transforms** で **Add visitor location headers** を有効にする。基準座標は個人情報に
当たるため `quaestor.config.json` へ書かず、上記3参照名を `set-stdin` で暗号化ストアへ登録
する。受領者座標と実距離は保存せず、合意監査には国・地域コードと基準半径の内外だけを
残す。この値は補助信号であり、OTP 合意を拒否・成立させる単独条件にはしない。

ユーザー ID 方式を使う場合は2行目の代わりに、例えば
`U012ABC;U345DEF` をクリップボードへコピーして登録する。

## 3. Amazon SES (請求書メールの送信元)

請求書リンク・パスキー登録時の本人確認コード・合意の控え (証跡バンドル添付) のメールは Amazon SES (SESv2 `SendEmail`) から送る。 SES は送信済み
本文を保持しないため、 運用者が「送信済み」フォルダからマジックリンクや本文を事後に読み返す
経路が無い。 Qs は Qs 専用の**送信専用 IAM キー**だけを暗号化ストアから読み、 運用者個人の
`AWS_ACCESS_KEY_ID` / 共有クレデンシャルファイル / SSO キャッシュには触れない。 以前の Gmail
ADC 方式 (運用者メールボックスに全リンクの写しが残る) は廃止済みで、 再導入しない。

1. SES コンソールで送信元ドメイン (例 `qs-magiclink.ai-run-do.com` のサブドメイン) を **Verified
   identity** として登録し、 表示された DKIM CNAME 3 本と MAIL FROM (SPF) の MX/TXT を Cloudflare
   DNS へ追加する。 DMARC (`_dmarc` TXT) も併せて公開する。
2. アカウントが SES サンドボックスなら **Request production access** で解除申請する
   (サンドボックスでは検証済みアドレス宛にしか送れない)。
3. IAM で送信専用ユーザーを作り、 次のポリシーだけを付ける (`<region>` `<account>` `<domain>` は
   実値に置換)。 `ses:FromAddress` 条件で送信元を固定し、 読み取り系のアクションは一切付けない。

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ses:SendEmail"],
    "Resource": "arn:aws:ses:<region>:<account>:identity/<domain>",
    "Condition": { "StringLike": { "ses:FromAddress": "invoice@<domain>" } }
  }]
}
```

4. アクセスキーを発行し、 暗号化ストアへ登録する (値をシェル引数・履歴へ出さない)。

```powershell
Get-Clipboard | npm run secret -- set-stdin QUAESTOR_SES_ACCESS_KEY_ID
Get-Clipboard | npm run secret -- set-stdin QUAESTOR_SES_SECRET_ACCESS_KEY
npm run secret -- list
```

5. `quaestor.config.json` の `invoiceShare.email.region` / `invoiceShare.email.fromAddress` を設定
   (または `QUAESTOR_SES_REGION` / `QUAESTOR_SES_FROM_ADDRESS`)、 Excubitor 経由で再起動する。

リージョン・送信元・資格情報のいずれかが欠けている間は、 リンク発行前に `503 not_configured`
で停止する。 SES が署名を拒否した場合は `502 authentication_failed`、 その他の送信失敗は
`502 api_error` で、 いずれも新規リンクは即時失効する。 Configuration set の event destination
を有効にしても、 SES イベントには本文・リンクは含まれない。

## 4. GA 学習ログ

OCR-GA の世代更新は `app_data/training/ga/evolution.jsonl` に毎回追記される
(ts / key / generation / evaluated / bestFitness / meanFitness / worstFitness / bestGenome)。
進化が効いているかは `bestFitness` の推移を見る。集団スナップショットは同階層の
`<key>.json` (内部に直近 200 世代の history も保持)。

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

web (ブラウザ) は `import.meta.env` を使わない。非シークレット設定は
`GET /v1/config` (app.ts) → `web/src/lib/runtime-config.ts` で受け取る。

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

## 3. Gmail API 用 Application Default Credentials

請求書リンクと合意確認コードのメール送信には、gcloud CLI が作る `authorized_user` ADC を
利用する。ADC には refresh token が含まれるため、リポジトリや Quaestor の暗号化ストアへ
コピーしない。Qs はユーザープロファイル内の正規 ADC を読み取り、access token はメモリ内
だけに短時間キャッシュする。

1. Google Cloud プロジェクトで Gmail API を有効化する。
2. OAuth 同意画面を構成し、Desktop app の OAuth client JSON を安全な一時場所へ保存する。
3. 次のように cloud-platform と gmail.send の両 scope を明示して ADC を作る。

```powershell
gcloud auth application-default login `
  --client-id-file="<OAuth client JSON の絶対パス>" `
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.send"
```

`cloud-platform scope is required` と表示された場合は、上記のように両方を指定する。確認は
次のコマンドで行い、出力された access token をチャット、ログ、ファイルへ貼り付けない。

```powershell
gcloud auth application-default print-access-token
```

Windows の正規保存先は `%APPDATA%\gcloud\application_default_credentials.json`。環境変数
`GOOGLE_APPLICATION_CREDENTIALS` が設定されている場合はそちらを正本とし、存在しないパスや
service-account 形式なら Qs は自動 fallback せず `503 not_configured` で停止する。古い override
が残っている場合は Excubitor 側の環境設定から削除し、サービスを所定の手順で再起動する。
ADC を破棄するときは `gcloud auth application-default revoke` を使う。

必要 scope は送信専用の `gmail.send`。メールの検索・閲覧 scope は Qs の配送機能へ付与しない。

## 4. GA 学習ログ

OCR-GA の世代更新は `app_data/training/ga/evolution.jsonl` に毎回追記される
(ts / key / generation / evaluated / bestFitness / meanFitness / worstFitness / bestGenome)。
進化が効いているかは `bestFitness` の推移を見る。集団スナップショットは同階層の
`<key>.json` (内部に直近 200 世代の history も保持)。

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
| `ocrSidecar.externalUrl` | `null` | 外部 sidecar 利用 (指定時は起動しない) | `QUAESTOR_OCR_SIDECAR_URL` |
| `training.gaRoot` | `app_data/training/ga` | OCR-GA 永続 + 学習ログ (ocr-ga.ts) | — |

web (ブラウザ) は `import.meta.env` を使わない。非シークレット設定は
`GET /v1/config` (app.ts) → `web/src/lib/runtime-config.ts` で受け取る。

## 2. シークレット — 暗号化ストア (`app_data/secrets.enc.json`)

API キー等は **平文でファイル保存しない** (§7.2)。

- 保存: AES-256-GCM (AEAD)。鍵は本体と分離して `~/.quaestor/secret.key` (初回自動生成)。
- 登録: `npm run secret -- set ANTHROPIC_API_KEY sk-ant-xxxx`
- 確認: `npm run secret -- list` (参照名のみ。値は出さない)
- 削除: `npm run secret -- remove ANTHROPIC_API_KEY`
- 利用: backend 起動時に `SecretStore.injectIntoEnv()` が復号してプロセスメモリ
  (process.env) へ注入する。ディスクには平文を書かない。
  既に env で渡されているキーは env が優先 (ストアは fallback)。

### Quaestor が使うシークレット

| 参照名 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Vision OCR / 銘柄マッピング / 優待取得 / 差分 Opus 類推 |

## 3. GA 学習ログ

OCR-GA の世代更新は `app_data/training/ga/evolution.jsonl` に毎回追記される
(ts / key / generation / evaluated / bestFitness / meanFitness / worstFitness / bestGenome)。
進化が効いているかは `bestFitness` の推移を見る。集団スナップショットは同階層の
`<key>.json` (内部に直近 200 世代の history も保持)。

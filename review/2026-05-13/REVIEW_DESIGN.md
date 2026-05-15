# REVIEW_DESIGN (2026-05-13)

評価: **B**

良: `src/server.ts:25` で `127.0.0.1` 既定の loopback only 方針を先頭コメントで宣言。 `src/db/schema.ts:45` `uniq_tx_source_id` で再 import dedupe を schema 担保。 `OcrClient` interface 化 (`src/services/ocr-client.ts:24`) + env なしで undefined degrade (`src/app.ts:90`)。

- D1(C) AIFormat §5 例外運用が README/DESIGN 宣言のみで本体未追記 (`README.md:37`, `DESIGN.md:143`)。
- D2(B) `src-tauri/tauri.conf.json:25` `csp: null`。 loopback + api.anthropic.com に limit を。
- D3(B) backend が認証無し loopback。 同マシン他プロセスから全 API 可。 起動時 secret を推奨。
- D4(B) `metadata TEXT` の `json_extract` 検索 (`src/db/receipts-repo.ts:88`) は index 不在でテーブルスキャン。
- D5(B) `UNIQUE(receipt_id, transaction_id)` (`src/db/schema.ts:107`) で 1:1 を schema 固定、 split match の v1+ 拡張で migration 必須。

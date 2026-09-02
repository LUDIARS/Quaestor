---
task: invoice-share-pr123-rereview
project: Quaestor
kind: レビュー
status: done
created: 2026-08-11
source_session: lictor-b97027da-62f4-4dfc-9e53-d94b1d716316
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# Revisor local PR #123 を縮退後の差分で再審査へ投入する

## 目的

`feat/invoice-public-magic-link` を `origin/main` へ rebase し、main に既にある公開PDFリンク、宛先台帳、
Gmail / Slack 配送、受領者OTP、合意・アクセス監査を巻き戻さず、次のハードニングだけを残した。

1. 請求書 `:id` の十進整数完全一致検証
2. 発行時サイズちょうどでPDFを読み、差し替えによる過大メモリ消費を防ぐ再検証
3. 公開リンクのレート制限追跡キー数の上限と退避

既存 Revisor local PR #123 にこの rebase 済み head を再審査させ、Revisor の通常検査・自動マージ判定へ
戻す。新規 GitHub PR や手動マージは行わない。

## 完了条件

- [x] (別経路で完了) Revisor local PR #123 は存在せず、3 ハードニングは main に別 PR で反映済み
      (`invoiceIdOf` / `readExactly` / `MAX_TRACKED_KEYS`)。 2026-09-03 に照合。
- [x] 発行者側 `/v1/invoices/:id` (get / patch / delete) も同じ十進整数完全一致に揃えた (`src/api/invoice-id.ts`)。
- [x] `feat/invoice-public-magic-link` は現行 main に対して 1.4 万行欠落しており再審査対象にしない (ブランチは残置)。

## スコープ (編集可ディレクトリ)

既存 local PR #123 の再審査可否を確認し、すでに main へ入ったハードニングを維持したまま、
`src/api` の発行者向け請求書ルートで ID 検証を共通化する。回帰テストは `tests/invoices.test.ts` に限定する。

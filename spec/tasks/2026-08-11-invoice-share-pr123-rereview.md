---
task: invoice-share-pr123-rereview
project: Quaestor
kind: レビュー
status: pending
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

- [ ] Revisor local PR #123 が現在の `feat/invoice-public-magic-link` head を対象に再審査される
- [ ] Revisor の自動検査結果がこの3ハードニングと現行 main の差分だけを対象としている
- [ ] Revisor が通過後に管理するマージ判定へ移行する（手動 merge / auto-merge はしない）

## スコープ (編集可ディレクトリ)

コード編集なし。Revisor の既存 local PR #123 の再審査投入だけを対象とする。

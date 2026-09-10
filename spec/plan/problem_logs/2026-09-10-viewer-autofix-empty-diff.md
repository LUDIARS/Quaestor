# Viewer掲載変更が自動修正で削除され差分が空になった

- Date: 2026-09-10
- Status: fixed in working tree
- Area: Viewer opt-in / Revisor review
- Severity: 依頼された掲載が反映できない

## Summary

Viewer設定3行を追加した変更に対し、Revisorが自動修正で全3行を削除した。
その後にマージ不能と「Review diff is empty; verify the registered base branch before retrying.」が通知された。

## Evidence

- bb8f9e7: quaestor-webにviewer.enabledとentry_pathを追加。
- ee63494: Revisor-Autofixとして追加3行を削除。
- main...HEADの差分が空。ベースは登録どおりmain。
- Revisor DBの審査理由は空配列で、削除理由は記録上確認できない。

## Cause

直接原因は自動修正による要求差分の取り消し。削除判断の根拠は不明。

## Fix Requirements

掲載設定を復元し、利用者の明示依頼・配信経路・受け入れ条件をspec/feature/excubitor-viewer.mdへ記録する。
レビュー回避やベース変更は行わず、同じ作業branchを再審査する。

## Verification

差分の目視とgit diff --checkのみ。テスト・起動・マージは実行しない。
審査後も要求のopt-inが残っていることを確認する必要がある。

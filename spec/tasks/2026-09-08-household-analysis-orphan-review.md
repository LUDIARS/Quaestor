---
task: household-analysis-orphan-review
project: Quaestor
kind: レビュー
created: 2026-09-08
memory_links:
  - spec/feature/household-bookkeeping.md
---
# 家計分析のレビューで orphaned と報告された4関数の到達性を確認する

## 目的

家計分析の実装レビューで「4 changed function(s) are orphaned」という非ブロック所見が出た。
関数名や検出根拠は通知に含まれていないため、未使用コードと断定せず、
呼び出し元・画面からの参照と解析側の検出範囲を照合する。

## 完了条件

- Revisor の該当レビュー詳細から、4関数の名前・ファイル・検出根拠を特定する。
- 家計 API、集計サービス、React コンポーネントから各関数への到達経路をソースで確認する。
- 実際の未接続、意図された公開入口、解析上の誤検出を根拠付きで区別し、Concordia に結果を記録する。
- 未接続がある場合は必要な接続修正を、誤検出の場合は解析側の再現条件を別タスクへ分解する。
  警告を消す目的だけで公開関数を削除したり、無意味な呼び出しを追加したりしない。

## スコープ (編集可ディレクトリ)

原則としてソース編集なし。参照対象は `src/api/household.ts`、`src/services/household/`、
`src/shared/household-*.ts`、`web/src/pages/HouseholdAnalysis.tsx`、
`web/src/components/Household*.tsx` と該当レビュー結果。
テストやサービス操作は実行せず、修正が必要な場合は別途範囲を確定する。

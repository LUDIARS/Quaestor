---
task: sample-label-backfill-run
project: Quaestor
kind: 雑用
created: 2026-09-03
memory_links:
  - spec/feature/scan-document-kinds.md
---
# 既存レシート 357 件に `npm run sample:label` でラベルを後付けする (本番 DB、 運用者作業)

## 目的

設計書 §3.1-5 の初期ベンチマーク。 D1 で入った後付け CLI (`src/cli/sample-label.ts`、 SPEC-SCAN-KIND-004) を
本番 `app_data/quaestor.db` に対して運用者 (neco) が実行し、 未ラベルの既存レシートに書類種別と
サンプルラベル (適切 / 特殊形状 / 対象外 + 形状タグ) を付ける。 1 件 ≈ 10 秒、 357 件 ≈ 1 時間。
実装セッションからは本番 DB に触らない (D1 の PR では未実行)。

手順の目安:

1. `npm run sample:label -- --dry-run` で対象件数と DB / model (`ocrClaudeCode.model`) を確認する。
2. `npm run sample:label -- --limit 5` で 5 件だけ流し、 撮影一覧 / レシート一覧のバッジで内容を目視する。
3. 全件 (`npm run sample:label`)。 中断しても再実行で続きから進む。 終了コード 2 なら失敗件があるので再実行する。
4. `GET /v1/receipts?sample_role=good_sample` / `special_shape` / `none` で分布を見る。

## 完了条件

- `sample_role IS NULL` かつ OCR 済みの receipts が 0 件 (`--dry-run` で `unlabeled: 0`)。
- ラベル分布 (good_sample / special_shape / none の件数、 形状タグの上位) を設計書 §3.2 の判定閾値の
  見直し材料として Castra の設計書に追記する (B-2 の夜間バッチと holdout 分割の入力になる)。
- 明らかな誤分類 (例: レシートが `other`) があれば一覧で 1 タップ上書きし、 傾向を prompt 改善の課題として残す。

## スコープ (編集可ディレクトリ)

- 本番データ `app_data/` (運用者のみ)
- Castra の設計書 `2026-09-03-quaestor-scan-diversification-ga-evaluation.md` (分布の追記)

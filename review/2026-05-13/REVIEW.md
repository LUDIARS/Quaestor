# Quaestor 自動レビュー (2026-05-13)

- 対象コミット: `d4d5404` (chore: declare least-privilege permissions for CI)
- レビュー観点: 個人金融データ保管境界 / 銀行クレデンシャル管理 / 設計・実装品質
- レビューア: Claude Opus 4.7 (LUDIARS auto-review)
- 評価尺度: A=合格 / B=軽微 / C=要対応 / D=要修正

## サマリ評価

| 観点 | 評価 | 主な根拠 |
|---|---|---|
| Design | B | DESIGN.md と実装の対応は良好。 ただし「Cernere 例外運用」 の AIFormat 側追記未完 (`README.md:37`, `DESIGN.md:143`) |
| Vulnerability | C | `--dangerously-skip-permissions` で claude CLI を fire-and-forget 起動 (`src/services/claude-code-ocr.ts:77`)、 画像が外部 API に渡る既定動線、 25MB base64 受領 (`src/api/receipts.ts:89`) |
| Implementation | B | smbc-bank importer の同期 interface fallback の食い違い (`src/importers/smbc-bank-pdf.ts:134`)、 amazon `total` 蓄積で 0 円判定が早期 (`src/importers/amazon-order-history.ts:125`) |
| Missing Features | C | reconcile の split / partial match 未実装、 ledger 編集 history (audit log) 無し、 Cernere 整合 issue 未作成 |
| Quality | B | テスト 13 本で coverage は十分、 型は strict。 `console`系・magic 数の点在、 SQL where 文の文字列連結 (allow-list 内なので可) |

詳細は同フォルダの `REVIEW_DESIGN.md` / `REVIEW_VULNERABILITY.md` / `REVIEW_IMPLEMENTATION.md` / `REVIEW_MISSING_FEATURES.md` / `REVIEW_QUALITY.md` を参照。

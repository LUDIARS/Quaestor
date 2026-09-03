---
task: scan-kind-ui-device-check
project: Quaestor
kind: テスト
created: 2026-09-03
memory_links:
  - spec/feature/scan-document-kinds.md
---
# 書類種別バッジと 1 タップ上書き UI のスマホ実機確認

## 目的

D1 の web 変更 (CONFIRMED / SCAN COMPLETE の種別・サンプル区分バッジ、 ShotCard と Receipts の
`DocKindLabels`、 `ScanGuide` の種別ごとの投入先一覧) は自動テストが無い (web にテストランナー未導入)。
実運用の入口はスマホ (Cloudflare Tunnel 経由の HTTPS、 360px 幅前後) なので、 実機で見た目と操作を確かめる。

確認項目:

- 撮影 → OCR 完了後、 CONFIRMED スタンプ直下と SCAN COMPLETE カード見出し下に種別バッジ
  (レシート / 請求書 / 検針票 / 明細 / 手書き / その他) とサンプル区分 (適切 / 特殊形状 / —) が出る。
  スタンプの回転 (-7deg) とバッジの位置が重ならない。
- ShotCard: バッジをタップするとチップ列 (種別 6 / サンプル 3 / 形状タグ / 内容タグ) が開き、
  チップ 1 タップで PATCH され、 ✍ が付く。 投入先未配線の種別では投入ボタンが押せず、 title に投入先が出る。
  種別をレシートに直すと投入できる。
- Receipts ページ: 同じ `DocKindLabels` が各行に出て、 月切替後も動く。
- ScanGuide パネル: 6 種の一覧が 9:16 のカメラ内に収まり、 スクロールできる。 タップで閉じる。
- `color-mix()` (バッジとチップの背景) が対象ブラウザ (iOS Safari / Android Chrome の実機バージョン) で効く。
  効かない場合は不透明色にフォールバックする。

## 完了条件

- 上記の各項目を実機で確認し、 崩れ・操作不能があれば `web/src/scan/DocKindLabels.css` /
  `web/src/scanner/ScannerOverlay.css` / `web/src/scan/ScanGuide.css` を直して同じ確認をやり直す。
- 結果 (機種 / ブラウザ / 崩れの有無) を PR または `spec/feature/scan-document-kinds.md` の末尾に 1 行残す。

## スコープ (編集可ディレクトリ)

- `web/src/scan/`、 `web/src/scanner/`、 `web/src/pages/Receipts.tsx`
- `spec/feature/scan-document-kinds.md`

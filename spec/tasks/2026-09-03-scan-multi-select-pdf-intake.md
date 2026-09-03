---
task: scan-multi-select-pdf-intake
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - castra:spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/scan-document-kinds.md
  - spec/feature/scanner-overlay.md
---
# 写真ライブラリの複数枚選択と PDF 共有の入口を足す (A-2 / 設計書 §2.3 P2)

## 目的

設計書 §2.1 の「入口の追加」。撮影画面は 1 つのまま、**まとめ撮り後の一括投入** と
**スマホの共有シートから来た PDF** を、既存のスキャン経路 (分類 → 抽出 → 投入) にそのまま流す。
種別判定は A-0 (D1、`doc_kind` 6 種) が済んでいるので、入口が増えても下流は変えない。

## 完了条件

- [ ] 写真ライブラリからの **複数枚選択**: 撮影画面のファイル入力を `multiple` にし、選んだ順に 1 枚ずつ
      既存の投入経路へ流す。1 枚ごとに ShotCard が立ち、失敗した枚だけ再試行できる (全体を巻き戻さない)。
- [ ] 進捗表示: 「n / m 枚目を処理中」を撮影画面に出す。**演出はエンジンの生死に依存しない**
      (`scanner-overlay.md` §1) を守り、抽出が遅れてもカードは先に立てる。
- [ ] **PDF 共有の入口**: PDF を受け取ったらページを画像化して同じ経路へ流す。複数ページは 1 ページ = 1 枚として扱う。
      画像化はサーバ側で行い、ブラウザに PDF レンダラを持ち込まない。ページ数の上限と、超えたときの
      エラーメッセージを決めて spec に書く。
- [ ] スマホの共有シートから来る経路 (PWA の `share_target`) を web app manifest に足し、`web/index.html` から
      manifest を参照する。`share_target` の `action` / `method=POST` / `enctype=multipart/form-data` / PDF の field 名を
      manifest と受け口で一致させ、受け取ったファイルは既存の receipt 作成・OCR キューへ渡す。共有専用の保存・分類経路は作らない。
- [ ] 同一ファイルの二重投入は既存の重複キー (種別別、A-1) で弾かれること。入口が増えたことで重複判定が
      緩まないことをテストで示す。
- [ ] spec: `spec/feature/scan-document-kinds.md` に入口 (単写 / 複数枚 / PDF 共有) を追記し、
      それぞれが同じ分類 → 抽出 → 投入に合流することを明記する。
- [ ] `npx tsc --noEmit -p tsconfig.json` 0 エラー、`npx vitest run` 全緑、`npm --prefix web run build` 通過。
      追加テスト: 複数枚の順次投入 (1 枚失敗しても残りが進む)、PDF → 画像化 → 投入、ページ数上限、
      share_target からの受け口。

## スコープ (編集可ディレクトリ)

`web/src/scan/`、`web/index.html`、`web/public/manifest*`、`src/api/receipts.ts`、`src/services/` (PDF 画像化の新規サービス)、
`spec/feature/`、`tests/`。`src/services/ocr-ga*` と `ocr-sidecar/` は触らない。本番 DB / 画像は読み取りのみ。

## 注意

- 種別の判定・完備条件・重複キーは A-1 の担当。ここでは **入口だけ** を足し、`receipt-commit.ts` の分岐を増やさない。
- PDF はメール取込の `PdfExtraction` と受け皿が重なる。既存実装を先に探し、使えるなら再利用する
  (設計で解く前に既存実装を探す)。

---
task: statement-scan-smart-import-merge
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - castra:spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/scan-document-kinds.md
---
# 明細スクショをスキャンに統合し、明細取込ページのスクショ入力を撤去する (A-3 / 設計書 §2.3 P3)

## 目的

neco 決定 (2026-09-03、設計書 §2.1): 明細スクショの入口を **スキャンに一本化** する。
今は「明細取込」ページ (`web/src/pages/Imports.tsx`) の「スクショ (jpg/png)」ファイル入力から
`POST /v1/imports/smart-screenshot` に入る別経路になっている。撮影/選択した画像が A-0 (D1) で
`statement` と分類されたら、A-1 で共通化した rows → transactions の投入処理へ流し、入口を 1 つ減らす。

## 完了条件

- [ ] A-1 で配線した `doc_kind = 'statement'` の投入処理を再利用し、`kind_fields.rows` を再抽出せず transactions に流す。
      既存の smart import と rows の正規化・`source_id` 生成を共通化し、同じ画像を再投入しても重複しない
      (設計書 §2.2 の表)。
- [ ] スキャン演出の CONFIRMED バッジに「明細として取込」を出し、ShotCard から取込結果
      (行数 / 期間 / 取込先) を辿れるようにする。
- [ ] 誤分類の救済: ShotCard で種別を `statement` に直した場合、種別変更で消える `kind_fields` を使い回さず、
      再解析で rows を得てから投入する。逆に `statement` から他種別へ直した場合は、receipt に紐づけて記録した
      import / transaction だけを取り消し、同じ `source_id` を持つ別経路の既存 transaction は消さない。
      再解析・投入・取り消しは再試行しても同じ結果になること (A-0 の「1 タップで直せる」と同じ導線)。
- [ ] 明細取込ページの **スクショ (jpg/png) 入力を撤去** する。CSV / PDF 明細とテキスト貼付の入力はそのまま残す。
      撤去後、ページに「スクショはスキャンから」と導線を出す。
- [ ] `POST /v1/imports/smart-screenshot` の扱いを決める: 呼び出し元が無くなるので削除する。
      残す場合 (外部連携等) は理由を spec に書く。
- [ ] spec: `spec/feature/scan-document-kinds.md` に statement の合流を追記し、明細取込ページに残る入口が
      CSV / PDF ファイルとテキスト貼付であることを反映する。
- [ ] `npx tsc --noEmit -p tsconfig.json` 0 エラー、`npx vitest run` 全緑、`npm --prefix web run build` 通過。
      追加テスト: statement 分類 → rows → transactions 投入、重複 `source_id` の弾き、種別修正時の再解析、
      receipt に紐づく rows だけの取り消し、各操作の再試行。
- [ ] `grep -rn "smart-screenshot" web/src` が 0 件。

## スコープ (編集可ディレクトリ)

`src/services/smart-import.ts`、`src/services/receipt-commit.ts`、`src/api/` (imports / receipts)、`src/db/` (投入元の紐づけ)、
`web/src/pages/Imports.tsx`、`web/src/scan/`、`spec/feature/`、`tests/`。
`src/services/ocr-ga*` と `ocr-sidecar/` は触らない。本番 DB / 画像は読み取りのみ。

## 注意

- A-1 (種別別の完備条件・重複キー・投入先) が先に入っている前提。分岐は `receipt-commit.ts` に集約したまま、
  API 側に散らさない (設計書 §2.2)。
- 明細取込ページには CSV / PDF、テキスト貼付、スクショの入口があり、`smart-import.ts` はテキスト / スクショの
  抽出と rows 変換を担う。共通化できる rows 変換を再利用し、スキャン用に第 2 実装を作らない。

---
task: ocr-ga-production-eval-baseline-backfill
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - spec/feature/ocr-ga-evaluation.md
  - spec/tasks/2026-09-03-ocr-ga-b1-capture-detect-backend.md
---
# 取り残された運用評価レコードの baseline を定期的に後追いで埋める

## 目的

B-1 で撮影ごとに運用評価レコード (`app_data/training/ga/production-eval.jsonl`) を発行するようにした。
勝ち遺伝子が既定遺伝子と違うとき `baselineFitness` は `null` で発行され、直後の背景タスクが既定遺伝子で
もう一度 `/detect` して同じ行を差し替える (`ProductionEvalLog.setBaseline`)。

この後追いは **プロセス内でしか走らない**。sidecar 不達、backend の再起動、`ocrDetectBaseline: false` の
運用では `baselineFitness` が `null` のまま残り、設計書 §3.2 の「実運用 (撮影ごとの運用評価)」KPI —
直近 20 件の fitness と baseline の差 — が算出できない (B-5 のカードで baseline 行が出せない)。

B-1 の即時後追いだけでは取り残しを定期的に拾う配線が無い。ここを塞ぎ、`null` が残り続けない状態にする。

## 完了条件

- [ ] `production-eval.jsonl` の `baselineFitness` が `null` のレコードを、画像と既定遺伝子で採点し直して
      埋める後追いジョブを追加する (`ProductionEvalLog` に未取得レコードの抽出を追加し、
      `ReceiptDetectService` の baseline 採点経路を再利用して採点ロジックを二重に書かない)。
- [ ] 実行契機は夜間 (`training.gaBench` と同じ流儀の設定 + `src/server.ts` からの起動・停止)。
      1 回あたりの件数上限を設定で持ち、撮影時 detect と sidecar を奪い合わないよう直列に流す。
      既定は無効ではなく **有効** (放置すると KPI が出ないため)。設定名と既定値は spec に書く。
- [ ] 画像が消えている / sidecar 不達 / receipt が削除済のレコードは、無限に再試行せず 1 回 warn を出して
      次へ進む (レコードは `null` のまま残す。ダミー値を入れない)。
- [ ] 埋めた baseline は `receipts.metadata.ocr_production_eval` 側にも反映する
      (jsonl と metadata で値がずれない)。行数は増やさない (1 撮影 = 1 レコードを保つ)。
- [ ] spec: `spec/feature/ocr-ga-evaluation.md` の SPEC-OCR-GA-EVAL-006 に後追いジョブの節を追記する
      (契機・件数上限・失敗時の扱い・設定キー)。
- [ ] `npx tsc --noEmit -p tsconfig.json` 0 エラー、`npx vitest run` 全緑、`npm --prefix web run build` 通過。
      追加テスト: 取り残しの抽出、埋めたあと行数が増えないこと、画像欠落 / sidecar 不達で `null` のまま
      残ること、metadata と jsonl の値が一致すること。

## スコープ (編集可ディレクトリ)

`src/services/receipt-detect/`、`src/services/app-config.ts` (設定キーの追加)、`src/server.ts`、
`spec/feature/`、`tests/`。`src/services/ocr-ga-bench/` (夜間 GA バッチ本体) と `ocr-sidecar/` は触らない。
本番 DB / 画像は読み取りのみ。

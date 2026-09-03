---
task: ocr-ga-b5-evolution-card
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/ocr-ga-evaluation.md
---
# 設定ページに「OCR 進化」カードを置き、ラベル別の GA 状態と sidecar 不達を見せる (B-5)

## 目的

OCR-GA が 2026-06-11 から一度も世代を進めていなかったのに誰も気付かなかったのは、進化の状態と
sidecar の生死がどこにも表示されていなかったから (設計書 §0-2(c))。D2 で `bench-report.json` と
`evolution.jsonl` (baseline / reseeded 付き) が出るようになったので、それを設定ページのカードに出し、
「測定系が死んでいる」状態を警告として見えるようにする。判定 (効いている / いない) は仮置きの
閾値なので自動化せず、数値を出すだけにする (設計書 §3.2)。

## 完了条件

- [ ] backend: `GET /v1/ocr-ga/status` を追加し、`bench-report.json` (ラベル / 件数 / 世代 / best / mean /
      baseline / holdout best / 1 個体秒数 / 最終評価時刻) と `evolution.jsonl` のラベル別 直近 N 世代の
      best・baseline 推移、sidecar `/health` の到達可否と `device`、`training.gaBench` の設定
      (enabled / hour / sidecarUrl / device) を返す。個人データ (店名・金額) は含めない。
- [ ] web: 設定ページ (`web/src/pages/Settings.tsx`) に「OCR 進化」カード。ラベルごとの行 + 小さな推移表示、
      `bench-report.json` が無い / sidecar 不達 / 評価 0 件 / 最終評価が 48 時間以上前 を **警告** として表示
      (演出側は従来どおり非依存のまま)。
- [ ] B-1 の運用評価レコード (`production-eval.jsonl`) があれば直近 20 件の fitness / fieldHits 平均と
      baseline 差も出す (無ければその行を出さない、ダミー値を出さない)。
- [ ] 夜間ジョブ (`training.gaBench.enabled`) を設定ページから on/off できる (`quaestor.config.json` へ書き戻し、
      `/v1/config/web` と同じ流儀)。反映は再起動後である旨を表示する。
- [ ] spec: `spec/feature/ocr-ga-evaluation.md` に SPEC-OCR-GA-EVAL-007 (観測カードと警告条件) を追記。
- [ ] `npx tsc --noEmit` 0 エラー、`npx vitest run` 全緑、`npm --prefix web run build` 通過。
      追加テスト: status API (report 無し / sidecar 不達 / 正常)、警告条件の純関数。

## スコープ (編集可ディレクトリ)

`src/api/ocr-ga.ts`、`src/api/config.ts`、`src/services/ocr-ga-bench/` (読み取り関数の追加のみ)、
`web/src/pages/Settings.tsx` と同ページの部品、`spec/feature/`、`tests/`。GA のロジック
(`genetic.ts` / `ocr-ga.ts` / fitness) と `ocr-sidecar/` は触らない。

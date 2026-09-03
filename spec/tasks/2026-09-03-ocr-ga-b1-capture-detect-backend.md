---
task: ocr-ga-b1-capture-detect-backend
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/ocr-ga-evaluation.md
  - spec/feature/scanner-overlay.md
---
# 撮影時の sidecar 検出を backend に移し、勝ち遺伝子の運用評価レコードを発行する (B-1)

## 目的

D2 (Revisor local PR #1260) で GA の学習をラベル別の夜間バッチへ移したが、撮影時の検出はまだ
ブラウザが sidecar を直叩きする設計のまま (`web/src/scanner/ocr-evolver.ts` / `ocr-genome.ts` /
`paddle-locator.ts`)。公開面 (Cloudflare Tunnel / HTTPS、スマホ) からは `http://127.0.0.1:17350` に
届かないため本物 BB が一度も出ておらず、学習レコードも 0 件のまま。

設計書 §3.1-4 のとおり、撮影ごとに **学習はしないが、最適化済みの勝ち遺伝子で 1 回だけ検出して採点する**
経路を backend に作る。撮影時評価 (web の OcrEvolver / fitnessVsTruth) は撤去し、fitness は D2 で
backend に移した `computeOcrFitness` に一本化する。

## 完了条件

- [ ] `POST /v1/receipts/:id/detect` を追加: LLM が返したタグ (D1 `sample_tags`) で
      `resolveBestGenome` (`GET /v1/ocr-ga/best` と同じ解決) の遺伝子を選び、`HttpOcrSidecarClient` で
      sidecar `/detect` を 1 回叩き、本物 BB (source=real, recognizedText, polygon) を返す。
- [ ] 検出結果を LLM 真値 (+ 人の修正) で `computeOcrFitness` により採点し、運用評価レコード
      `{ receiptId, label, tags, generation, genome, fitness, fieldHits, baselineFitness, elapsedMs, ts }` を
      `app_data/training/ga/production-eval.jsonl` と `receipts.metadata` に書く。baseline (既定遺伝子) は
      同期で間に合わなければ後追いでよい。
- [ ] 検出は演出と切り離して非同期に行う。間に合わなければ演出は従来の fallback (Tesseract → 比率推定) で進め、
      レコードは後から発行する (演出はエンジンの生死に依存しない、`scanner-overlay.md` §1 の大原則を守る)。
- [ ] web: `OcrEvolver` / `EvolvedFieldLocator` / `ocr-genome.ts` / `fitnessVsTruth` を撤去し、`PaddleFieldLocator`
      は backend の `/v1/receipts/:id/detect` を呼ぶ形に変える。`GET /v1/config` の `ocrSidecarUrl` 公開と
      `web/src/lib/runtime-config.ts` の `ocrSidecarUrl()` を止める。
- [ ] `POST /v1/ocr-ga/generation` (撮影時の世代更新) は呼び出し元が無くなるので削除する
      (残す場合は理由を spec に書く)。
- [ ] 学習レコード (`POST /v1/receipts/:id/regions`、`training-dataset.ts`) に backend 検出の本物 BB が
      流れること。運用評価レコードの直近 20 件平均が baseline を下回り続けたら `bestGenome` を
      default に戻す判定は **自動化せず**、値をログに出すだけにする (閾値は仮置き、B-5 のカードで見る)。
- [ ] spec: `spec/feature/ocr-ga-evaluation.md` に SPEC-OCR-GA-EVAL-006 (撮影時の運用評価) を追記し、
      `scanner-overlay.md` §7 の「次 PR B-1 で置き換え」を実装済みに改訂。
- [ ] `npx tsc --noEmit` 0 エラー、`npx vitest run` 全緑、web の `npm --prefix web run build` 通過。
      追加テスト: detect API (sidecar モック、タグ→遺伝子解決、fallback)、運用評価レコードの書式、
      web の locator が backend 経路を呼ぶこと。

## スコープ (編集可ディレクトリ)

`src/api/receipts.ts`、`src/services/` (ocr-ga / ocr-ga-fitness / ocr-sidecar-client / training-dataset の
呼び出し側)、`src/app.ts`、`web/src/scanner/`、`web/src/lib/runtime-config.ts`、`spec/feature/`、`tests/`。
`ocr-sidecar/` と D2 の `src/services/ocr-ga-bench/` は触らない。本番 DB / 画像は読み取りのみ
(receipts.metadata への追記は既存の `setOcrResult` 系と同じ経路で行う)。

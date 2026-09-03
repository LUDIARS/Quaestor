---
task: ocr-ga-b7-detect-stage-cache
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/ocr-ga-evaluation.md
  - spec/tasks/2026-09-03-ocr-ga-b6-gpu-batch-speedup.md
  - ocr-sidecar/README.md
---
# GA バッチの detect を stage 分割し、rec 結果を遺伝子をまたいで使い回す (B-7)

## 目的

B-6 の実測 (設計書 §3.4) で、GPU 1 画像あたり det **0.25 s** に対しパイプライン全体 **1.75 s**、
**rec が約 86% を占める**ことが分かった。一方で GA の遺伝子のうち `dropScore` は
PaddleOCR の `text_rec_score_thresh` に渡るだけの **rec スコアの後段フィルタ**で、
det にも rec の計算にも影響しない。にもかかわらず `ocr-sidecar/main.py` の `_genome_key` は
`dropScore` をキーに含めるため、**`dropScore` だけ違う個体ごとに**

- PaddleOCR インスタンスを作り直し (実測 **約 8.6 秒**)、
- 同じ画像の det + rec を丸ごと再実行する (実測 約 1.0〜1.75 秒)

という二重の無駄が出ている。集団 8 で全 357 件を 1 世代回すと約 53 分 (B-6 実測 1.30 s/detect ×
約 2430 detect) で、1 時間枠にほぼ張り付いている。この無駄を削れば、同じ枠で集団か世代数を増やせる。

**このタスクは「速くする」ことが目的で、fitness の値を変えてはならない。** 同じ遺伝子・同じ画像なら
現行と同一の `lines` が返ること (dropScore のフィルタ結果を含め) を回帰テストで固定する。

## やること

1. **`_genome_key` を stage 別に割る** (`ocr-sidecar/main.py`)。
   - `det_key` = `detThresh` / `boxThresh` / `unclipRatio` / `limitSideLen` / `useDilation`
   - `rec_key` = 現状 rec の計算に効く遺伝子は無い (`dropScore` は後段フィルタ)
   - PaddleOCR インスタンスのキャッシュは `det_key` だけで引く。`dropScore` は
     **インスタンス生成パラメータから外し**、`/detect` の応答を組み立てるときに
     `score >= dropScore` で絞る。これにより `dropScore` だけ違う個体では追加のインスタンス生成が
     0 回になるが、画像ごとの推論は引き続き走る。推論も省くには次項の結果キャッシュが必要。
   - PaddleOCR 3.x では `text_rec_score_thresh` を **渡さずに** 生成し、フィルタを自前で行う
     (2.x の `drop_score` も同様)。既定値のときの挙動が現行と一致することをテストで確かめる。
2. **画像 × det_key の推論結果キャッシュを sidecar に持つ** (任意、1 の効果を測ってから判断)。
   夜間バッチは同じ画像を個体数ぶん繰り返し送るので、`(det_key, 画像ハッシュ)` で
   `lines` (フィルタ前) をキャッシュすれば、det 系が同じ個体は 2 個体目以降が実質 0 秒になる。
   メモリ上限と LRU を決める (画像 357 件 × det_key 数)。バッチ用途のみで、運用 sidecar の
   常駐メモリを増やさないよう既定 off (`--cache-detections` / env) にする。
3. **`/detect?stage=det`** (det の polygon だけ返す、rec を回さない) を足す。
   det 単体は 0.25 s なので、det の当たり判定だけを見たい用途 (将来の det 専用 fitness、
   B-1 の撮影時 detect のプレビュー) に使える。**本タスクでは endpoint と応答形だけ用意し、
   GA の fitness は変えない** (現行 fitness は text が要るため rec を必要とする)。
4. `ocr-ga-bench` 側は原則変えない。1 の効果は `bench-report.json` の `totalSeconds` /
   `secondsPerIndividual` / `detectCalls` の比較で測る (B-6 と同じ `--limit 50 --population 8` で
   前後を取る)。
5. `ocr-sidecar/README.md` の API 表と `spec/feature/ocr-ga-evaluation.md` SPEC-OCR-GA-EVAL-005 を更新し、
   設計書 §3.4 に前後の実測を追記する。

## 完了条件

- [ ] `dropScore` だけ違う遺伝子で `/detect` を叩いても PaddleOCR インスタンスが増えないこと
      (`/health.cached_genomes` が増えない) を確認するテスト。
- [ ] 同じ遺伝子・同じ画像で、変更前と同じ `lines` (件数・text・score・polygon) が返る回帰テスト。
      `dropScore` によるフィルタ境界 (score がちょうど閾値) を含める。
- [ ] `/detect?stage=det` が polygon のみを返し、`text` を返さないこと。既定 (`stage` 無し) は現行と同じ。
- [ ] `--limit 50 --population 8 --generations 1` を GPU sidecar (別 venv `.venv-gpu`、別 port) で
      前後 1 回ずつ回し、`totalSeconds` の改善を設計書 §3.4 に追記する (B-6 の 466.1 s が基準)。
- [ ] `npx tsc --noEmit -p tsconfig.json` 0 エラー、`npx vitest run` 全緑。
- [ ] 運用の常駐 sidecar (`:17350`、CPU、supervisor 起動) の設定既定を変えない。
      検証で起動した sidecar は作業終了時に停止する。

## スコープ (編集可ディレクトリ)

`ocr-sidecar/` (`main.py` / `README.md`)、`spec/feature/ocr-ga-evaluation.md`、`spec/tasks/`、
`tests/`、および Castra 設計書 §3.4 の追記。本番 DB / 画像は読み取りのみ、
GA 永続は `--out tmp/` に限定する。

---
task: ocr-ga-b6-gpu-batch-speedup
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/ocr-ga-evaluation.md
  - ocr-sidecar/README.md
---
# GA バッチ用 sidecar の GPU 化と評価高速化を実機で検証し、夜間 1 時間枠に収める (B-6)

## 目的

D2 のスモーク (運用 sidecar、CPU) では 1 画像の `/detect` に 70 秒前後 (新 genome のインスタンス生成込み)、
2 画像 × 2 個体で 287 秒かかった。357 件 × 8 個体を 1 晩 (1 時間枠) で回すには桁が足りない
(設計書 §3.4「評価を速くする → 集団を増やす」)。D2 で入れた `--device gpu` / `/health.device` の
判定経路を使い、GPU wheel と前処理縮小の効果を実機 (GTX 1070) で測り、夜間バッチの規模
(`generationsPerNight` / `--limit` / `--population`) を決められる数字を設計書に残す。

## 完了条件

- [ ] `ocr-sidecar/README.md`「GPU はバッチ側だけ」の手順で **別 venv** (運用の `.venv` は触らない) に
      `paddlepaddle-gpu` を入れ、`python main.py --device gpu --port 17351` の `/health` が
      `device: "gpu"` を返す。PTX 不一致 (`no kernel image is available` / `CUDA_ERROR_INVALID_PTX`) なら
      CUDA 11.8 系 wheel に切り替えて再検証し、結果 (wheel の版 / CUDA / ドライバ / 症状) を README に追記する。
- [ ] 同じ画像 5 枚 × 既定遺伝子で CPU (17350) と GPU (17351) の `/detect` 所要を測り、
      `npm run ga:bench -- --sidecar http://127.0.0.1:17351 --device gpu --limit 10 --population 4 --generations 1 --out tmp/ga-gpu`
      の `bench-report.json` (1 個体秒数 / 総秒数) を設計書 §3.4 に追記する。
- [ ] 前処理縮小: 評価画像を長辺 960 に事前縮小した場合の所要と fitness の差を測る (sidecar 側 `limitSideLen`
      とは別に、送る画像自体を縮小)。効くなら `ocr-ga-bench` の corpus 読み込みにオプションとして入れ、
      `training.gaBench` に設定を足す (既定は縮小なし)。
- [ ] det と rec の分離 (genome の det 系だけ違う個体は rec を再実行しない) は、計測で rec が支配的なら
      sidecar に `/detect?stage=det` を足す設計だけ書き、実装は別タスクに切る (本タスクでは計測まで)。
- [ ] 計測結果から夜間バッチの規模を決め、`quaestor.config.json` の `training.gaBench`
      (`generationsPerNight` / `sidecarUrl` / `device`) の推奨値を `spec/feature/ocr-ga-evaluation.md` に書く。
      判定閾値 (20 世代 / +0.05 / 直近 20 件) の決め直しは、この数字と B-0 のラベル別 baseline 分布を
      neco に見せて判断を仰ぐ (自動化しない)。
- [ ] 運用の常駐 sidecar (supervisor 起動、CPU) の設定既定は変えない。GPU sidecar を常駐させるなら
      Excubitor catalog に別サービスとして登録する提案を書く (本タスクでは登録しない)。

## スコープ (編集可ディレクトリ)

`ocr-sidecar/` (README / requirements の GPU 版は別ファイル `requirements-gpu.txt` に分ける)、
`src/services/ocr-ga-bench/` (縮小オプション)、`src/services/app-config.ts`、`quaestor.config.json`、
`spec/feature/ocr-ga-evaluation.md`、Castra 設計書 §3.4 の追記、`tests/`。本番 DB / 画像は読み取りのみ、
GA 永続は `--out tmp/` に限定し `app_data/training/ga` を汚さない。

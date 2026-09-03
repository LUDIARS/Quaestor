---
task: ocr-ga-gpu-sidecar-residency
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - E:/Document/Ars/spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md
  - spec/feature/ocr-ga-evaluation.md
  - spec/tasks/2026-09-03-ocr-ga-b6-gpu-batch-speedup.md
  - ocr-sidecar/README.md
  - E:/Document/Ars/Excubitor/catalog/FRAGMENTS.md
---
# GA バッチ用 GPU sidecar を常駐させ、夜間バッチを GPU 設定へ切り替える

## 目的

B-6 で GPU が実機で動くこと (GTX 1070 / `paddlepaddle-gpu==3.3.1` / CUDA 11.8、PTX 不一致なし) と、
`/detect` が CPU 80.3 s → GPU 0.69 s (約 116 倍)、全 357 件 × 集団 8 で 1 世代 ≈ 53 分で
1 時間枠に収まることを確認した。しかし **GPU sidecar はまだ常駐しておらず、夜間バッチは
`enabled:false` / `device:"cpu"` のまま動いていない**。B-6 は計測と推奨値の記録までで、
起動経路と設定の切り替えは意図的に手を付けていない。

このタスクで「毎晩 GA が回る」状態にする。推奨値と catalog fragment の案は
`spec/feature/ocr-ga-evaluation.md`「実測と推奨設定」にあるので、**まず常駐方針を決めてから**入れる。

## 先に決めること (実装前にユーザ判断を仰ぐ)

- **常駐か、夜間だけか。** 常駐すると GPU メモリを約 3 GB 占め続け、デスクトップの他用途
  (ゲーム / 生成 AI / 動画) と競合する。夜間だけなら Excubitor の起動・停止をバッチ時刻に
  合わせる仕組み (`autostart:false` + 時刻起動、または backend からの起動) が要る。
- どちらを選ぶかで catalog の `autostart` と、`training.gaBench.hour` との関係が変わる。

## 完了条件

- [ ] `Quaestor/excubitor.catalog.yaml` に GPU sidecar (`quaestor-ocr-gpu`、port 17351) を追加する。
      運用 sidecar (`:17350`) は Quaestor backend が supervisor で起こすので catalog には出さない。
      `cwd` は `${ARS_ROOT}/Quaestor/ocr-sidecar`、`command` は `.venv-gpu` の python で
      `main.py --device gpu --port 17351`。`.venv-gpu` が別 venv (約 4.5 GB) である前提をコメントに残す。
- [ ] `ocr-sidecar/.venv-gpu` を **プロジェクト本体の checkout**
      に用意する。B-6 で作ったものは worktree 側にあるため、worktree を消すと一緒に消える。
      手順は `ocr-sidecar/requirements-gpu.txt` と README「GPU はバッチ側だけ」。
      **運用の `.venv` (CPU) は触らない。** `paddlepaddle` と `paddlepaddle-gpu` を同居させない。
- [ ] `health` の `interval_sec` と初回猶予を cold start (最初の `/health` に約 7.4 秒) に合わせる。
- [ ] `quaestor.config.json` の `training.gaBench` を GPU 設定へ切り替える:
      `enabled: true` / `sidecarUrl: "http://127.0.0.1:17351"` / `device: "gpu"` /
      `generationsPerNight: 1` (全 357 件 × 集団 8 で 1 世代 ≈ 53 分。2 以上は 1 時間枠を超える)。
      `spec/setup/config-and-secrets.md` の既定値の記述と食い違わないようにする。
- [ ] **1 晩実際に回して結果を確認する。** `app_data/training/ga/bench-report.json` と
      `evolution.jsonl` に global の世代が 1 つ進み、`totalSeconds` が 1 時間枠に収まっていること。
      失敗していたら原因 (sidecar 不達 / device 不一致 / GPU メモリ) を突き止めてから閉じる。
- [ ] 常駐させた場合に GPU メモリが枯れないことを確認する。集団 8 (遺伝子 9 種) 評価後で
      5.7 GB / 8 GB だった。`ocr-sidecar/main.py` の `_OCR_CACHE_MAX = 12` を埋めると
      8 GB を超える恐れがあるので、必要なら上限を下げる。

## スコープ (編集可ディレクトリ)

`excubitor.catalog.yaml`、`quaestor.config.json`、`spec/setup/config-and-secrets.md`、
`spec/feature/ocr-ga-evaluation.md`、`ocr-sidecar/README.md`、`spec/tasks/`。
本番 DB / 画像は読み取りのみ。夜間バッチの初回実行は本番 `training.gaRoot` に書くので、
事前に `app_data/training/ga` をバックアップしてから回す。

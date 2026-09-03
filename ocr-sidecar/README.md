# Quaestor OCR sidecar (PaddleOCR)

レシート画像から **正確な polygon + text** を返す PaddleOCR (PP-OCRv5) の microservice。
Quaestor web/backend がフォールバック段の本命 (`PaddleFieldLocator`) として叩く。
詳細設計は `../spec/feature/scanner-overlay.md` §4 (点3-B)。

## 役割

- detection (DBNet系) + recognition で文字/行の **本物 BB** を返す → 検知 BB の演出分離 (点1) と
  ブラックボックス学習データ収集 (点2) の供給源。
- ローカル・オフライン・無料。日本語含む 106 言語対応。

## セットアップ (1 回だけ)

venv + 依存を用意する。これだけやれば以降は **Quaestor 起動時に自動で同時起動** する。

```powershell
# Windows
./ocr-sidecar/setup.ps1
```
```bash
# Linux / macOS
./ocr-sidecar/setup.sh
```

初回の OCR 実行時にモデルを自動 DL する (~数十MB、`~/.paddleocr` にキャッシュ)。

**python は 3.9〜3.12 を使うこと** (paddlepaddle が 3.13+ の wheel を出していない。
3.14 では `No matching distribution found for paddlepaddle` で setup が失敗する)。
setup スクリプトは `quaestor.config.json` の `ocrSidecar.venvPython` を読む
(null なら 3.12→3.9 を自動探索) ので、PATH の python が新しすぎても安全。
PaddleOCR は 2.x / 3.x どちらでも動く (main.py が API を自動判別。3.x は PP-OCRv5)。

## 自動起動 (Quaestor と同時)

Quaestor backend (`src/server.ts`) が起動時に `OcrSidecarSupervisor` でこの sidecar を
子プロセスとして立ち上げる (`.venv` の python → 無ければ PATH の python)。
クラッシュ時は backoff 付きで再起動。ログは `app_data/ocr-sidecar.log`。

設定は `quaestor.config.json` の `ocrSidecar` セクション (正本。env は override のみ、
詳細は `../spec/setup/config-and-secrets.md`):

- 無効化: `"manage": false`
- 外部 sidecar を使う: `"externalUrl": "http://host:port"` (本機は起動しない)
- port 変更: `"port"` (既定 17350) / 言語: `"lang"` (既定 japan) / python 明示: `"python"`

## 手動起動 (任意)

```bash
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 17350   # posix
.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 17350  # win
```

## API

| method | path | body | resp |
|---|---|---|---|
| POST | `/detect` | multipart `image` (+任意 `genome` JSON) | `{ lines: [{ polygon, bbox, text, score }], width, height, genome }` |
| GET | `/health` | — | `{ ok, model, paddleocr_major, cached_genomes, device, requested_device, device_error }` |

`bbox` = `[x, y, w, h]`、`polygon` = 4 点 `[[x,y],...]` (いずれも画像ピクセル座標)。
`device` は実際に使っている device (`cpu` / `gpu`)。`gpu` を要求して CPU に落ちたときは
`device_error` に理由が入る (backend の GA バッチは `device=gpu` 設定時にこれを見て停止する)。

## GPU はバッチ側だけ (SPEC-OCR-GA-EVAL-005)

`/detect` は CPU で 1 回 40 秒 (warm) かかり、GA の夜間バッチ (`npm run ga:bench` /
`training.gaBench`) には遅い。GPU は **バッチが叩く 2 本目の sidecar だけ** で使い、
Quaestor が同時起動する運用 sidecar (撮影時 detect) は CPU のまま変えない。

```powershell
# 2 本目を GPU で立てる (別 port)。落ちたら CPU に自動フォールバックし /health に理由を出す
.venv\Scripts\python.exe main.py --device gpu --port 17351
# env でも同じ (uvicorn 直起動のとき)
$env:QS_OCR_DEVICE = "gpu"; .venv\Scripts\python.exe -m uvicorn main:app --port 17351
```

backend 側は `quaestor.config.json` の `training.gaBench.sidecarUrl` を `http://127.0.0.1:17351`、
`training.gaBench.device` を `gpu` にする (または `npm run ga:bench -- --sidecar ... --device gpu`)。
`device=gpu` なのに sidecar が `cpu` を報告したらバッチは走らず、エラーで止まる (黙って CPU で
1 晩回さない)。

### GPU wheel の導入手順 (2026-09-03 に B-6 で実機検証済み)

1. **paddlepaddle-gpu の版を CUDA に合わせる。** `pip install paddlepaddle-gpu==<ver>` は
   PyPI の既定 wheel が CUDA 11.8 / 12.x のどれかに固定されているので、PaddlePaddle 公式の
   インストール表 (Windows / pip / CUDA 版) で **paddlepaddle と同じ版番号** の
   `paddlepaddle-gpu` を、対応する index URL 付きで入れる。`.venv` の `paddlepaddle` (CPU) を
   先に `pip uninstall` する (両方入れると import が CPU 版を掴む)。
2. **CUDA 要件**: NVIDIA ドライバが CUDA runtime の版以上であること (`nvidia-smi` の CUDA Version)。
   wheel によっては cuDNN と `cublas` DLL を PATH に置く必要がある (Windows)。
3. **GTX 1070 の注意**: compute capability 6.1 (Pascal)。CUDA 12.x の公式 wheel は
   sm_61 の SASS を含まないことがあり、その場合 **PTX から JIT** される。
   CUDA 11.8 系の wheel の方が確実。PaddlePaddle 3.x は CUDA 11.8 / 12.6 の wheel を出している。
4. **PTX 不一致時の症状**: `/health` の `device_error` に
   `OSError: (External) CUDA error(209), no kernel image is available for execution on the device`
   や `cudaErrorInvalidPtx` / `CUDA_ERROR_INVALID_PTX` が入り、sidecar は CPU で動き続ける。
   同じ PC で Ollama が PTX 不一致で落ちた前例があるので、まずこの `/health` で判定する。
5. 確認: `/health` の `device` が `gpu`、`/detect` の所要が CPU 比で数倍速いこと。
   結果は設計書 (Castra `spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md` §3.4) に追記する。

### 検証結果 (2026-09-03、B-6、検証機)

**PTX 不一致は起きなかった。** CUDA 11.8 系 wheel で GTX 1070 (sm_61) がそのまま動く。
Ollama の前例は再現しない。

| 項目 | 値 |
| --- | --- |
| wheel | `paddlepaddle-gpu==3.3.1` (`cp39-cp39-win_amd64`)、index `https://www.paddlepaddle.org.cn/packages/stable/cu118/` |
| paddle の CUDA / cuDNN | `paddle.version.cuda()` = 11.8 / `paddle.version.cudnn()` = 8.9.6 |
| GPU | NVIDIA GeForce GTX 1070、compute capability 6.1、8191 MB、15 SM |
| ドライバ | 560.94 (Driver API 12.6 / Runtime API 11.8) |
| python | 3.9.6 (運用 `.venv` と同じ) |
| 症状 | 無し。`paddle.matmul` 成功、`/health` = `{"device":"gpu","device_error":null}` |

- **CUDA runtime と cuDNN の DLL を手で PATH へ置く必要は無かった。** wheel が
  `nvidia-cuda-runtime-cu11` / `nvidia-cudnn-cu11` / `nvidia-cublas-cu11` 等を pip 依存として
  引き込む (上記手順 2 の但し書きはこの wheel には当てはまらない)。
- `.venv-gpu` は **約 4.5 GB** (CUDA ライブラリ込み)。DL も約 2.5 GB あるので初回導入は時間がかかる。
- 運用の `.venv` (CPU) とは **別 venv**。`paddlepaddle` (CPU) と `paddlepaddle-gpu` を同居させない。

導入手順 (実際に通したもの):

```powershell
python -m venv ocr-sidecar/.venv-gpu           # 運用の .venv とは別
ocr-sidecar/.venv-gpu/Scripts/python.exe -m pip install --upgrade pip setuptools wheel
ocr-sidecar/.venv-gpu/Scripts/python.exe -m pip install -r ocr-sidecar/requirements-gpu.txt
cd ocr-sidecar; ./.venv-gpu/Scripts/python.exe main.py --device gpu --port 17351
curl http://127.0.0.1:17351/health            # device: "gpu" を確認
```

### 計測 (2026-09-03、レシート 5 枚 × 既定遺伝子、608x1080)

| 経路 | 1 画像の `/detect` | 備考 |
| --- | --- | --- |
| CPU (`:17350`、運用 sidecar) | 平均 **80.3 s** (49.4〜108.9) | 別パスで平均 90.4 s。負荷で 27〜194 s と振れる |
| GPU (`:17351`、`.venv-gpu`) | 平均 **0.69 s** (0.49〜0.88) | 検出行数は CPU と同一 (57/40/55/42/27 行) |

- **約 116 倍**。GA の夜間バッチは GPU 前提でなければ成立しない (CPU では 1 世代に数十時間)。
- ただし **新しい遺伝子ごとに PaddleOCR インスタンス生成で約 8.6 秒** かかる
  (同一遺伝子の 2 回目は約 1.0 秒)。1 世代のコストは
  `画像数 × 個体数 × 約 1 秒 + 新遺伝子数 × 約 8.6 秒`。個体数を増やすより
  **1 個体あたりの画像数を増やす方が償却が効く**。
- **前処理縮小 (長辺 960) は効かない。** コーパス 357 件のうち 356 件が 608x1080 で、
  det は既定 `limitSideLen=960` (`limit_type=max`) で 960 に落としている。実測でも
  平均 89.4 s (縮小) vs 90.4 s (原寸)、fitness 差 **0.0000** (5 枚すべて一致)。
  そのため `ocr-ga-bench` に縮小オプションは入れていない (詳細は
  `../spec/feature/ocr-ga-evaluation.md`)。
- 冷えた GPU sidecar への **最初の `/health` は約 7.4 秒** かかる (paddle import + CUDA 初期化 +
  カーネル読込)。`HttpOcrSidecarClient` の `/health` 既定タイムアウト 5 秒より長いので、
  バッチから叩く前に一度 `/health` を呼んで温めるか、タイムアウトを延ばす
  (`spec/feature/ocr-ga-evaluation.md` の「残」参照)。

## web/backend からの接続

- web は env を使わない。backend の `GET /v1/config` が `quaestor.config.json` 由来の
  sidecar URL を返し、`web/src/lib/runtime-config.ts` が解決する。
- 未起動でも web は Tesseract → Fallback に自動退避する (`ChainedFieldLocator`)。

## C (将来): YOLO 学習

点2 で蓄積した `app_data/training/receipts/yolo/` (画像 + 正規化ラベル) を使い、
レシート領域/フィールド検出器を学習する。学習スクリプトは `train/` に置く想定 (未実装)。
データが十分貯まってから着手。

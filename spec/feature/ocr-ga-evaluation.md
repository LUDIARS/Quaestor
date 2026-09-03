# OCR-GA のラベル別オフライン評価 (ocr-ga-evaluation)

設計書: Castra `spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md` §3 (neco 判断 §5)。
撮影のたびに GA を評価するのをやめ、LLM が OCR 時に付けるサンプルラベル (D1: `sample_role` /
`sample_tags`) でコーパスを分け、学習 (評価 + 世代更新) はラベル別に夜間バッチで回す。
撮影時は勝ち遺伝子を引くだけ (次 PR B-1)。演出 (`scanner-overlay.md` §1) はこれまでどおり
sidecar / GA の生死に依存しない。

関連コード:
- `src/services/ocr-ga.ts` — 遺伝子スキーマ、集団キー (ラベル) の規則、best の解決
- `src/services/ocr-ga-fitness.ts` — fitness (純関数)
- `src/services/ocr-sidecar-client.ts` — backend → sidecar `/detect` `/health` (1 並列・タイムアウト)
- `src/services/ocr-ga-bench/` — corpus-builder / corpus-split / evaluator / report / bench-runner / nightly-job
- `src/cli/ga-bench.ts` — `npm run ga:bench`
- `src/api/ocr-ga.ts` — `/v1/ocr-ga/{population,generation,best}`
- `ocr-sidecar/main.py` — `--device cpu|gpu`、`/health.device`

## SPEC-OCR-GA-EVAL-001 — ラベル別コーパス

- 集団キーは **ラベル** だけ: `global` (good_sample 全体) と `tag:<形状タグ>` (special_shape の各タグ)。
  店舗別キーは廃止。`POST /v1/ocr-ga/generation` と `GET /population` に来たそれ以外のキー (旧 web の
  payee 由来キーを含む) は `global` に丸める (`normalizeGaKey`)。タグは小文字英数字と `_` に正規化する。
- コーパスの母集団は receipts のうち `ocr_status IN ('done','manual')` かつ `image_path` があるもの。
  真値は receipts の `date / payee / total / items` (LLM 出力 + 人が投入時に直した値、修正後を正とする)。
- ラベルの決め方 (`sample_role` / `sample_tags` は D1 が足す列):
  | sample_role | 所属 |
  | --- | --- |
  | `good_sample` | `global` |
  | `special_shape` | `sample_tags` の各 `tag:<x>` (有効タグが無ければ `global`)。複数タグなら各タグに入る |
  | `none` | 学習に使わない |
  | NULL (未ラベル) / 不明値 | `global` (後付けラベルが済むまでのつなぎ) |
- **列が無い DB でも動く**: `PRAGMA table_info(receipts)` で列の有無を見て、無ければ全件を `global` とする。
- タグの件数が `MIN_LABEL_CORPUS` (10) 未満なら集団を作らず、そのレシートを `global` に含める。
- train / holdout は receipt id の sha1 で決定的に 80 / 20 に分ける (`corpus-split.ts`)。件数や実行順で
  所属が変わらない。`--limit` はラベルごとに新しい順に効き、split の前に適用する。

## SPEC-OCR-GA-EVAL-002 — fitness

`computeOcrFitness(lines, truth, { elapsedMs, costPerSecond })` (backend、純関数)。
web の `fitnessVsTruth` と同じ入出力 (sidecar 行 + 真値 → 0..1) で、以下を加える。

- 正規化を真値側と行側で揃える: 日付は年/月/日/曜日/時刻/区切りを落とし `YYYYMMDD` (和暦は西暦化)、
  金額は `¥ , 円 -` を落として整数 (全角→半角)、店名は NFKC (半角カナ→全角) → `normalizePayee` → 空白除去、
  items は NFKC + 小文字化 + 記号除去。店名 / items は候補行が真値を丸ごと含めば 1 (後ろに TEL や金額が
  続いても減点しない)、一部だけなら長さ比。
- 隣接行結合: y 中心の間隔が行高 × 1.6 以内で連続する 2〜3 行を連結した候補も照合する。
- 重み: total 0.4 / date 0.3 / payee 0.2 / items 0.1。真値の無いフィールドは重みから外して正規化する。
- 1 行加点: 結合候補で当てた場合は 0.9 倍 (= 真値が 1 行 (bbox 1 つ) に収まる個体を優遇)。
- コスト項: `fitness = clamp01(score − costPerSecond × 評価秒数)`。係数は `training.gaBench.costPerSecond`
  (既定 0.0005、0 で無効)。
- `fieldHits {date, payee, total}`: date と total は正規化後の完全一致、payee は類似度 0.8 以上。
  ラベル別 holdout での hit 率が KPI「field hit rate」。
- 部分点: 日付は月日だけ一致で 0.75、金額 / 店名 / items は正規化文字列の類似度 (包含は長さ比、
  それ以外は Levenshtein 比)。hit にはならない。

## SPEC-OCR-GA-EVAL-003 — 夜間バッチと report

- 評価は **backend → sidecar** (`HttpOcrSidecarClient`)。ブラウザから sidecar を叩かない。detect は
  1 並列に直列化し、タイムアウト (既定 180 秒) で待ち続けない。画像を別 origin に転送しないよう
  HTTP redirect は拒否し、credential を埋め込んだ sidecar URL も受け付けない。
- 世代の単位は「ラベル別コーパス (train) 1 周」。1 個体の fitness = train の平均。1 レシート 1 世代はやめる。
- 各世代で既定遺伝子 (`defaultOcrGenome`) を同じ train で採点した **baseline** を記録し、
  `GaStore.recordGeneration(key, evaluated, { baselineFitness })` に渡す。best が baseline を下回る世代が
  5 回続いたら集団を既定 + ランダムで再 seed する (再 seed ガード、`reseedAfterBelowBaseline`)。
- best は holdout でも採点する (train − holdout で過学習を見る)。同じ遺伝子 × 同じ画像の detect はキャッシュ。
- 出力:
  - `evolution.jsonl` (GaStore の logFile): 世代ごとに ts / key / generation / evaluated / best / mean /
    worst / bestGenome / **baselineFitness / reseeded**。
  - `<gaRoot>/bench-report.json`: ラベルごとの直近結果 (ラベル / 件数 train・holdout / 世代 / best (fitness・
    genome・fieldHitRate) / mean / worst / baseline / holdout best・baseline / 1 個体秒数 / 総秒数 / detect
    回数 / errors / reseeded / ts) + sidecar URL / device。ラベル単位で上書きし、走らせなかったラベルは残す。
- CLI: `npm run ga:bench -- --label global --generations 1 --limit 20 --population 4 --out <dir>`。
  `--out` を渡すと本番 `app_data/training/ga` を汚さない。DB は read-only で開く。進捗は stderr、
  report は stdout (JSON)。
- 夜間ジョブ: `quaestor.config.json` `training.gaBench { enabled:false, hour:3, generationsPerNight:1,
  sidecarUrl:null, device:'cpu', costPerSecond:0.0005 }`。`enabled` 既定 false。server.ts が ocrWorker と同じ
  経路で起動・停止する。前回が走っていれば skip、失敗 (sidecar 不達) は warn で翌日へ。
- fail-fast: sidecar `/health` 不達、`ok=false`、指定ラベルがコーパスに無い、train が全件 detect 失敗、
  train 対象が 0 件、同じ出力先で別バッチが実行中、評価中に対象世代が更新された、のいずれも例外で止める
  (0 点・stale な集団で世代を進めない、黙って CPU で回さない)。世代更新は期待世代との CAS と
  process lock で直列化し、CLI / 夜間ジョブの同時実行も run lock で拒否する。集団 snapshot と report は
  一時ファイルからの atomic replace で、途中終了時に既存 JSON を壊さない。

## SPEC-OCR-GA-EVAL-004 — best 取得 API

`GET /v1/ocr-ga/best?tags=long,faded` → `{ key, source, generation, fitness, genome }`。

- `tags` の順に `tag:<x>` の集団に記録 (history) があればそれ (`source: "tag"`)、無ければ `global`
  (`source: "global"`)、それも無ければ既定遺伝子 (`source: "default"`, fitness null)。
- best は history 中の **歴代最良** (bestFitness 最大) を返す。集団ファイルを seed しただけで記録の無い
  キーは「無い」扱い。
- 撮影時 detect (次 PR B-1、`POST /v1/receipts/:id/detect`) がこれを引いて sidecar に渡す。

## SPEC-OCR-GA-EVAL-005 — GPU はバッチ側

- `ocr-sidecar/main.py` は `--device cpu|gpu` (env `QS_OCR_DEVICE` / `QUAESTOR_OCR_DEVICE`) を受ける。
  `gpu` は paddle の GPU 初期化 (CUDA build 確認 → `set_device("gpu:0")` → 小さな matmul でカーネル読込)
  を試し、失敗したら CPU にフォールバックして `/health` に `device` (実際) / `requested_device` /
  `device_error` (理由) を出す。黙って劣化しない。
- 運用の常駐 sidecar (supervisor 起動) は CPU のまま。設定既定 (`ocrSidecar`) は変えない。
- バッチは `training.gaBench.sidecarUrl` (GPU 版など 2 本目) を叩き、`training.gaBench.device = gpu` の
  ときは `/health.device` が `gpu` でなければ走らせない (エラー停止)。
- GPU wheel の導入は本 PR ではやらない。手順と注意 (paddlepaddle-gpu の版 / CUDA 要件 / GTX 1070 の
  compute capability 6.1 / PTX 不一致時の症状) は `ocr-sidecar/README.md`「GPU はバッチ側だけ」。

## 判定基準 (仮置き、設計書 §3.2)

「20 世代で best が baseline +0.05 未満なら効いていない」「train − holdout > 0.10 で過学習」などは
仮置きで、判定は自動化しない。B-0 (ラベル後付け) と最初の夜間バッチが回った時点で、`bench-report.json`
のラベル別 baseline 分布と 1 個体秒数を見て決め直す。

## 残 (次 PR)

- B-1: 撮影時 detect を backend に移し (`POST /v1/receipts/:id/detect`)、`GET /v1/ocr-ga/best` の遺伝子で
  1 回だけ sidecar を叩く。運用評価レコード (`production-eval.jsonl`)。web の `OcrEvolver` /
  `ocr-genome.ts` / `fitnessVsTruth` を撤去し、`ocrSidecarUrl` の web 公開を止める。
- B-5: 設定ページ「OCR 進化」カード (`bench-report.json` と `evolution.jsonl` の可視化、sidecar 不達の警告)。
- B-6: 評価高速化の検証 (縮小 / GPU wheel / det-rec 分離) と、判定閾値の確定。

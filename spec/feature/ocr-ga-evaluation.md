# OCR-GA のラベル別オフライン評価 (ocr-ga-evaluation)

設計書: Castra `spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md` §3 (neco 判断 §5)。
撮影のたびに GA を評価するのをやめ、LLM が OCR 時に付けるサンプルラベル (D1: `sample_role` /
`sample_tags`) でコーパスを分け、学習 (評価 + 世代更新) はラベル別に夜間バッチで回す。
撮影時は勝ち遺伝子を引いて **1 回だけ検出し、その結果を採点する** (運用評価、SPEC-OCR-GA-EVAL-006)。
演出 (`scanner-overlay.md` §1) はこれまでどおり sidecar / GA の生死に依存しない。

関連コード:
- `src/services/ocr-ga.ts` — 遺伝子スキーマ、集団キー (ラベル) の規則、best の解決
- `src/services/ocr-ga-fitness.ts` — fitness (純関数)。`payeeKey` / `itemKey` は撮影時の行マッチングでも使う
- `src/services/ocr-sidecar-client.ts` — backend → sidecar `/detect` `/health` (1 並列・タイムアウト)
- `src/services/ocr-ga-bench/` — corpus-builder / corpus-split / evaluator / report / bench-runner / nightly-job
- `src/services/receipt-detect/detect-service.ts` — 撮影時 detect (遺伝子解決 → sidecar 1 回 → 採点 → レコード発行)
- `src/services/receipt-detect/field-regions.ts` — 認識行 ↔ 真値のマッチング (本物 BB)
- `src/services/receipt-detect/production-eval-log.ts` — `production-eval.jsonl` の読み書きと直近 n 件の平均
- `src/services/receipt-detect/types.ts` — 運用評価レコードと detect 結果の型
- `src/services/detection-record.ts` — 本物 BB → `training-dataset.ts` の共通経路 (detect と `/regions` の両方)
- `src/cli/ga-bench.ts` — `npm run ga:bench`
- `src/api/ocr-ga.ts` — `/v1/ocr-ga/{population,best}`
- `src/api/receipts.ts` — `POST /v1/receipts/:id/detect`
- `web/src/scanner/backend-detect-locator.ts` — web は backend の detect だけを呼ぶ (sidecar を直叩きしない)
- `web/src/scan/captureUpload.ts` — `kickDetect()` (OCR 真値が揃った撮影に 1 回だけ detect をキック)
- `web/src/scan/ManualShutter.tsx` — poll から `kickDetect`、confirm の locator に backend 段を挿す
- `ocr-sidecar/main.py` — `--device cpu|gpu`、`/health.device`

## SPEC-OCR-GA-EVAL-001 — ラベル別コーパス

- 集団キーは **ラベル** だけ: `global` (good_sample 全体) と `tag:<形状タグ>` (special_shape の各タグ)。
  店舗別キーは廃止。`GET /population` に来たそれ以外のキー (旧 web の payee 由来キーを含む) は
  `global` に丸める (`normalizeGaKey`)。タグは小文字英数字と `_` に正規化する。
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
世代を進める経路は夜間バッチ (`ocr-ga-bench`) **だけ**。撮影時に web が集団を進めていた
`POST /v1/ocr-ga/generation` は撮影時評価ごと撤去した (SPEC-OCR-GA-EVAL-006)。

- `tags` の順に `tag:<x>` の集団に記録 (history) があればそれ (`source: "tag"`)、無ければ `global`
  (`source: "global"`)、それも無ければ既定遺伝子 (`source: "default"`, fitness null)。
- best は history 中の **歴代最良** (bestFitness 最大) を返す。集団ファイルを seed しただけで記録の無い
  キーは「無い」扱い。
- 撮影時 detect (`POST /v1/receipts/:id/detect`、SPEC-OCR-GA-EVAL-006) がこれを引いて sidecar に渡す。

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

## SPEC-OCR-GA-EVAL-006 — 撮影時の運用評価 (勝ち遺伝子を実運用で採点する)

学習 (世代更新) は撮影ごとにやらないが、**最適化済みの勝ち遺伝子が実運用でどれだけ当てたか**は
撮影のたびに測る。設計書 §3.1-4 / §3.2「実運用」KPI の実体。

### 経路

`POST /v1/receipts/:id/detect` (`src/api/receipts.ts` → `src/services/receipt-detect/detect-service.ts`)。

1. LLM が付けた `sample_tags` で `resolveBestGenome` (SPEC-OCR-GA-EVAL-004 と同じ tag → global → 既定)。
2. その遺伝子で `HttpOcrSidecarClient` が sidecar `/detect` を **1 回だけ** 叩く。
   **ブラウザから sidecar は叩かない** — `GET /v1/config` の `ocrSidecarUrl` 公開と
   `web/src/lib/runtime-config.ts` は廃止し、sidecar URL は backend だけが持つ。
3. 認識行を LLM 真値 (+ 人が投入時に直した値、修正後が正) と突合して本物 BB にする
   (`field-regions.ts`)。正規化は fitness (SPEC-OCR-GA-EVAL-002) と同じ (`payeeKey` / `itemKey` /
   日付・金額トークン)。1 フィールド = 1 行、同じ行は 2 つのフィールドに割り当てない。
4. `computeOcrFitness` で採点し、**運用評価レコードを 1 件発行**する。
5. 本物 BB を `training-dataset.ts` に流す (`detection-record.ts` 経由、engine=`paddle`)。
   `POST /v1/receipts/:id/regions` (web の Tesseract 由来 BB) も同じ関数を通る。
   detect 由来の領域は backend が保存済なので、web は `persisted` を立てて再送しない。

### 運用評価レコード

`<gaRoot>/production-eval.jsonl` に **1 行 = 1 レコード**。同じ内容を `receipts.metadata`
(`ocr_production_eval`) にも置き、リプレイ用に検出スナップショット (`ocr_detect`) を添える。

```
{ receiptId, label, tags, generation, genome, fitness, fieldHits{date,payee,total},
  baselineFitness, elapsedMs, ts }
```

- `label` は採用した集団キー、`generation` はその best を記録した世代 (既定遺伝子なら 0)。
- `baselineFitness` は同じ画像を **既定遺伝子** で採点した値。勝ち遺伝子が既定と同じなら同期で入り、
  違えば `null` で発行して **後追いで埋める** (`setBaseline` が該当行を差し替える。行数は増えない)。
  後追いの検出は応答も演出も待たせない (`ocrDetectBaseline: false` で無効化できる)。
- 失敗 (sidecar 不達 / OCR 未完 / 画像欠落) はレコードを作らない (0 点で平均を汚さない)。

### 空振りと並行

- sidecar 不達・タイムアウト・OCR 未完了・画像欠落は **200 で `source` 無しの空結果**
  (`reason` に `sidecar_failed` / `ocr_not_ready` / `image_missing` / `no_lines`)。理由はログに出す。
  呼び出し側の演出は従来の fallback (Tesseract → 比率推定) で進む。
- 同一 receipt への並行 detect は 1 本に畳む (二重に 40 秒を走らせない)。呼び出し側が
  タイムアウトで諦めても検出は最後まで走り、レコードと学習データは後から発行される。
- sidecar 実行中に真値が修正された場合は修正後の値で採点する。画像または採用遺伝子まで変わった場合は
  古い検出を発行せず、最新入力で 1 回だけ再試行する。
- 評価済 receipt は画像・真値・タグの fingerprint が一致するときだけ metadata のスナップショットを返す。
  人手修正後は cache を無効化し、`?force=1` でも明示的に測り直せる。
- shutdown は新規 detect を止め、進行中の検出と baseline の永続化を drain してから sidecar / DB を閉じる。

### 判定は自動化しない

直近 20 件の平均 (`ProductionEvalLog.summary`) は **ログに出すだけ**。平均が baseline を下回っても
`bestGenome` を既定に戻す処理は入れない (閾値は仮置き。人が B-5 の「OCR 進化」カードで見る)。

## 判定基準 (仮置き、設計書 §3.2)

「20 世代で best が baseline +0.05 未満なら効いていない」「train − holdout > 0.10 で過学習」などは
仮置きで、判定は自動化しない。B-0 (ラベル後付け) と最初の夜間バッチが回った時点で、`bench-report.json`
のラベル別 baseline 分布と 1 個体秒数を見て決め直す。

## 残 (次 PR)

- B-5: 設定ページ「OCR 進化」カード (`bench-report.json` / `evolution.jsonl` / `production-eval.jsonl` の
  可視化、sidecar 不達の警告)。直近 20 件と baseline の差はここで人が見る。
- B-6: 評価高速化の検証 (縮小 / GPU wheel / det-rec 分離) と、判定閾値の確定。
  1 回 40 秒のままでは撮影時 detect が confirm に間に合わない (演出は fallback で進む) ので、
  「実運用で本物 BB を出せた率」を上げるにはここが効く。

# Scanner Overlay — レシート検知演出 & 検出エンジン

シャッター撮影後の「サイバー HUD スキャン演出」と、その裏で動く検出/OCR エンジンの設計。

関連コード:
- `web/src/scanner/` — 演出ライブラリ (ScannerOverlay / use-scan-pipeline / types / *-locator)
- `web/src/scan/ManualShutter.tsx` — 撮影画面 (演出を呼ぶ消費側)
- `src/services/*ocr*` — バックエンド OCR (Claude Vision)
- `ocr-sidecar/` — PaddleOCR microservice (本物 BB + text 供給源)

---

## 1. フェーズ遷移

```
idle → detect → analyze → result → locate → confirm
```

| フェーズ | 演出 | 領域(regions)の出所 |
|---|---|---|
| detect | スキャンライン + CRT ノイズ | 比率ヒューリスティック (演出用、source=heuristic) |
| analyze | **精度替え再スキャンループ (下記)** | probe マーカー (合成 or 本物 lines) |
| result | CONFIRMED スタンプ | OCR 値を比率領域に充填 |
| locate | 再スキャンライン (紫、ループ。**LOCATE_TIMEOUT_MS=6s 上限**) | — (fieldLocator 実行中) |
| **confirm** | **余韻スロースキャン (5 秒) + 本物 BB + 離れたコールアウト** | **fieldLocator が返す実ピクセル BB (source=real)** |

### 演出の大原則 (2026-06-12 リワークで確立)

**演出は外部エンジン (sidecar / GA / Tesseract) の生死に依存しない。**
データが届けば本物に昇格し、届かなければ演出用データで回す。
locate はタイムアウトで必ず confirm へ前進する (詰まって固まる経路を作らない)。

### analyze 中の精度替え再スキャンループ (2026-06-12)

`ScannerOverlay` が **自走**で `RESCAN_PERIOD_MS` (2.2s) ごとに pass を進め、
琥珀色スキャンライン (`sc-evolveline`, `RESCAN_SWEEP_MS`=1.6s) を流し直し、
ライン通過に同期して probe マーカー (`kind="probe"`, 最大 24) を置き直す。
LLM 解析が終わるまで何度でもくり返す。

- マーカーの出所 (`probe-regions.ts`): `synthesizeProbes(pass)` — pass を seed にレシート行風の
  マーカーを決定論的に合成する。テキストは出さない (嘘の認識結果は出さない)。
  撮影時の検出は backend へ移り 1 回 40 秒かかるので、analyze 中に本物の検出行は届かない
  (2026-09-03 改訂。旧: OCR-GA attempt の検出行を `probesFromLines()` で昇格していた)。
- メタ表示 (`sc-evolve` バッジ): `RE-SCAN PASS nn · PRECISION x.xx` (どちらも演出値)。
- probe 表示中は偽 YOLO ノイズ箱を抑制。probe は演出専用で学習データに乗らない。
- 演出ループは完全に自走する — 外部エンジンの進捗を受け取る口 (`evolution` / `liveProbes`) は無い。

detect/analyze の比率 BB は **演出** であり学習に使わない。
**学習に使う「検知した文字の BB」は confirm フェーズの `source=real` 領域**。

---

## 2. 検知 BB と演出テキストの分離 (点1)

`source=real` の領域は以下のように **2 レイヤーに分けて** 描画する:

1. **BB レイヤー (`sc-box`)** — 検出器が当てた実ピクセル座標にタイトな枠 (コーナーブラケット + 十字)。
   画像上の文字位置に正確に重なる。**加工しない** = これがそのまま学習データ。
2. **コールアウトレイヤー (`sc-callout`)** — ラベル / 認識テキスト / 値 / 信頼度バーを
   BB から **離した位置** (画面端寄り) に配置し、BB 中心と **リーダー線 (`sc-leader`)** で接続。

配置計算は `callout-layout.ts` が担当 (SRP):
- BB が画面左半分なら callout を右マージンへ、右半分なら左マージンへ。
- 複数 callout は縦に積んで重なりを避ける。
- リーダー線は BB エッジ → callout エッジ。

`source=heuristic` / `noise` 領域は従来どおり box 内にラベルを描く (後方互換、演出のまま)。

### locate のタイムアウト保証 (2026-06-12)

`useScanPipeline` は locate を `Promise.race` で `LOCATE_TIMEOUT_MS` (6s) と競争させる。
失敗 / 空 / 時間切れの場合は `FallbackFieldLocator` (heuristic、常に返る) を即時実行して
**必ず confirm に到達**させる。Tesseract の言語モデル DL ハングや sidecar 死で
locate に居座り続ける経路は存在しない。locate 中の紫ラインはループ再生。

### confirm の余韻スロースキャン + 終端演出 (2026-06-12 改訂)
- LLM 解析確定 (locate 完了) 後、**ゆっくりした全体スキャンライン (`sc-finalline`,
  `CONFIRM_SCAN_DURATION_MS`=5s) を 1 本流し、ライン通過に同期して枠を順に出す**。
  - 各枠の delay は pipeline が y 座標 → 5 秒スキャンの通過時刻に再マップ
    (spread = 5s − 1s で最後の枠も 5 秒以内に reveal 完了)。
  - **1 つの枠の演出 (LockonShrink) に 1 秒** (`CONFIRM_REVEAL_MS`)。callout は枠 +150ms。
- **5 秒後に confirm を出す**: CONFIRMED スタンプ + `ScannerSummary` カード (全項目リスト +
  呼吸グロー) を表示し、**全項目表示のまま待機**する。
- **画面タップ**で exit: `sc-exitline` が上から下へ全体スキャンラインを流し、オーバーレイ内容を
  フェードしながら scanner (カメラ) に戻す (`EXIT_DURATION_MS`)。CLOSE ボタンも同じ exit を通る。
- fieldLocator 無し (result のみ) の経路は従来どおり自動 dismiss。

---

## 3. 本物 BB を必ず渡す & 学習データ化 (点2)

### データモデル (`types.ts` の `DetectedRegion`)

```ts
interface DetectedRegion {
  // ... 既存 (id/label/x/y/width/height/confidence/color/value/delay/kind)
  /** BB が検出器由来の実座標か、比率推定か。real のみ学習に使う */
  source?: "real" | "heuristic";
  /** 認識した生テキスト (学習ラベル)。value は表示整形済、こちらは生 */
  recognizedText?: string;
  /** 回転レシート用の 4 点ポリゴン (PaddleOCR が返す)。任意 */
  polygon?: Array<[number, number]>;
  /** backend detect が既に学習データへ保存済。true の領域は /regions へ送り返さない */
  persisted?: boolean;
}
```

### 永続化 (`src/services/training-dataset.ts`)

confirm 時、web は本物 BB を backend に POST → JSONL データセットに追記する。

- 1 レコード = `{ attemptId, receiptId, imageRef, naturalWidth, naturalHeight, engine, regions: [{ bbox, polygon?, text, label }], ts }`
- 保存先: `app_data/training/receipts/records/<receiptId>.json` + 追記ログ
  `app_data/training/receipts/regions.jsonl`
- **YOLO 形式エクスポート**: `exportYolo()` が画像コピー + `<class> <cx> <cy> <w> <h>` (正規化) のラベル txt を出力 → C で直接学習に使える。

エンドポイント: `POST /v1/receipts/:id/regions`
- body: `{ engine, naturalWidth, naturalHeight, regions: DetectedRegion[] }`
- `source=real` の領域のみ保存。heuristic/noise は破棄。
- 保存 → 差分算出 → (差分時) Opus 類推の一連は `src/services/detection-record.ts` に集約し、
  撮影時 detect (`POST /v1/receipts/:id/detect`) と同じ関数を通す。detect 由来の BB は backend が
  既に保存しているので、web は `persisted` を立てて送り返さない (二重記録を作らない)。
- 学習 snapshot は検出 attempt ごとの immutable id を持つ。Opus 類推が遅れて完了しても、同じ receipt に
  後から保存された別 engine / attempt の snapshot へ差分評価を付け替えない。

---

## 4. 検出/OCR エンジン (点3)

### 現状 (改修前)
- レシート矩形: `SobelReceiptEngine` (エッジ検出ヒューリスティック)
- フィールド値: Claude Vision (`claude -p`、BB なし)
- フィールド位置: `FallbackFieldLocator` (比率推定、BB なし) ← 配線中

### B (本 PR): PaddleOCR sidecar
- `ocr-sidecar/` — FastAPI + PaddleOCR (PP-OCRv5、日本語対応)。
  - `POST /detect` 画像 (multipart/base64) → `{ lines: [{ polygon, bbox, text, score }] }`
  - detection(DBNet系) + recognition 一体で **正確な polygon + text** を返す。
  - ローカル・オフライン・無料。明細表は PP-Structure で拡張可。
- `web/src/scanner/backend-detect-locator.ts` — `BackendDetectFieldLocator implements FieldLocatorEngine`
  - backend の `POST /v1/receipts/:id/detect` を呼ぶ (**sidecar はブラウザから叩かない**)。
    遺伝子解決・sidecar 呼び出し・採点・学習レコード保存は backend の責務
    (`spec/feature/ocr-ga-evaluation.md` SPEC-OCR-GA-EVAL-006)。
  - backend が返す領域に表示ラベル / 色 / 値を付け、`source:"real"` + `recognizedText` +
    `persisted:true` にする。
  - 自前の短い timeout (`BACKEND_DETECT_TIMEOUT_MS` = 3.5s) で打ち切り、同じ locate の中で
    次段へ譲る (backend の 1 回は 40 秒、`LOCATE_TIMEOUT_MS` は 6 秒)。打ち切っても backend 側の
    検出と採点は最後まで走る。
- 起動: `ocr-sidecar/README.md` 参照 (`uvicorn main:app`、既定 port 17350)
- URL は `quaestor.config.json` の `ocrSidecar` が正本 (env は override のみ) で、**backend だけが持つ**。
  `GET /v1/config` の `ocrSidecarUrl` 公開と `web/src/lib/runtime-config.ts` は廃止した
  (公開面 / HTTPS からブラウザが `127.0.0.1` に届かないため、経路ごと無くす)。

### フォールバック段
```
BackendDetectFieldLocator (backend → sidecar)  ←本命、正確 BB。3.5 秒で打ち切り
  ↓ 空 / 失敗 / 時間切れ
TesseractFieldLocator (ブラウザ、word BB)  ←sidecar が間に合わなくても本物 BB
  ↓ 失敗
FallbackFieldLocator (比率推定、BB なし)  ←最終手段、演出のみ
```
合成は `ChainedFieldLocator` (`web/src/scanner/field-locator.ts`)。

### C (将来): 自前 YOLO 検出器
- B が蓄積した JSONL/YOLO データセットでレシート領域/フィールド検出器を学習。
- recognition は Paddle/Tesseract を併用 (YOLO は領域検出のみ)。
- データが十分貯まったら別タスクで着手。学習 pipeline は `ocr-sidecar/train/` に置く想定。

---

## 5. 設計判断の評価 (decision-metrics)

| 案 | 学習量 | 作業コスト | 解決度 | 主目的一致 |
|---|---|---|---|---|
| A. Vision に bbox も返させる | 2 | 小 | 3 | 3 |
| **B. PaddleOCR sidecar** | 4 | 中 | 5 | 5 |
| C. 自前 YOLO 学習 | 5 | 大 | 4 | 4 |

採用: **B→C 段階構成** (2026-06-11 決定)。
B で正確 BB+text を即供給し点1/点2を達成 → 学習データ蓄積 → 十分貯まったら C。

---

## 6. 毎レシートの検出差分評価 + Opus 類推 (2026-06-11 追加)

検出系の精度を上げるため、confirm のたびに「検出器の認識テキスト」と
「LLM(Vision) 抽出フィールド = **絶対正解**」を突合し、差分を評価する。

- **真値**: Claude Vision OCR の date/payee/total/items。現状 LLM 検出にミスは無い前提で
  絶対正解として扱う (ユーザ確認済 2026-06-11)。
- **差分 (毎回・安価)**: `detection-eval.ts` の `computeDetectionDiff()` が純関数で算出。
  フィールドごとに status = match / mismatch / missing / no_reference + 正規化類似度。
  結果は学習レコード (`records/<id>.json` の `diff`) + `evals.jsonl` に保存。
- **Opus 類推 (差分がある時だけ)**: `detection-diff-evaluator.ts` の `OpusDiffEvaluator`
  (`claude-opus-4-8`, tool_use 強制) が**差分テキストのみ**(画像なし)から検出挙動を類推:
  - failureMode = localization (位置ずれ) / recognition (読み違い) / partial / none
  - hypothesis (なぜその差分か) + suggestedFix (検出器/前処理の改善案) + confidence
  結果は学習レコードの `evaluation` に追記。`ANTHROPIC_API_KEY` 未設定なら差分のみ保存。
- **経路**: `POST /v1/receipts/:id/regions` が append → diff 算出 → (差分時) Opus を
  fire-and-forget で起動 (HTTP 応答はブロックしない)。コストは差分発生時のみ。

蓄積された diff/evaluation は C(自前 YOLO/検出器) の弱点分析 + 学習データの質向上に使う。

---

## 7. OCR パラメータの遺伝的最適化 (OCR-GA) — 撮影時評価は廃止予定、ラベル別バッチへ (2026-09-03 改訂)

LLM(Vision) 検出待ちの間にブラウザが sidecar を回して GA を評価する設計 (2026-06-11) は、
実運用で **一度も世代が進まなかった** (Castra 設計書 `spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md` §1.3)。
公開面 (Cloudflare Tunnel / HTTPS、スマホ) から `http://127.0.0.1:17350` に届かず、`/detect` は CPU で
1 回 40 秒と LLM 待ち (10 秒前後) に収まらず、失敗は演出非依存の仕様どおり黙って飲み込まれた。

方針 (neco 判断 2026-09-03): **撮影のたびに評価しない。** LLM が OCR 時に付けるサンプルラベル
(`sample_role` / `sample_tags`、D1) でコーパスを分け、学習 (評価 + 世代更新) は **ラベル別に夜間バッチ**
で backend → sidecar で回す。正本は `spec/feature/ocr-ga-evaluation.md`。

### 今の構成 (D2 で移行済)
- 汎用 GA エンジン `src/services/genetic.ts` (再 seed ガード付き) と OCR 特化 `src/services/ocr-ga.ts` は据え置き。
- **集団キーはラベル** (`global` / `tag:<形状タグ>`)。店舗別キー (payee 由来) は廃止し、API に来た
  それ以外のキーは `global` に丸める。
- fitness は backend `src/services/ocr-ga-fitness.ts` (正規化・隣接行結合・重み・1 行加点・コスト項)。
- 評価は `src/services/ocr-ga-bench/` (コーパス / holdout 分割 / 評価器 / report / 夜間ジョブ)、
  手動は `npm run ga:bench`。sidecar は `src/services/ocr-sidecar-client.ts` で backend から叩く。
- `GET /v1/ocr-ga/best?tags=...` がタグ優先で勝ち遺伝子を返す。

### 撮影時 (B-1 で置き換え済、2026-09-03)
- web の `OcrEvolver` / `EvolvedFieldLocator` / `ocr-genome.ts` / `fitnessVsTruth` は **撤去した**。
  撮影時に集団を進めていた `POST /v1/ocr-ga/generation` も呼び出し元ごと削除した
  (世代を進めるのは夜間バッチだけ)。
- 置き換え後: backend の `POST /v1/receipts/:id/detect` がラベルの `bestGenome` で sidecar を 1 回叩き、
  本物 BB を confirm と学習レコードに流し、運用評価レコード (`production-eval.jsonl` +
  `receipts.metadata`) を 1 件発行する。正本は `spec/feature/ocr-ga-evaluation.md`
  SPEC-OCR-GA-EVAL-006。
- `ocrSidecarUrl` の web 公開 (`GET /v1/config`) と `web/src/lib/runtime-config.ts` は廃止した。
- 検出は演出と非同期。1 回 40 秒なので confirm には基本間に合わず、演出は従来の fallback
  (Tesseract → 比率推定) で進み、評価レコードは後から発行される (§1 の大原則は不変)。

### sidecar
`ocr-sidecar/main.py` の `/detect` は従来どおり `genome` (JSON) を受ける。`--device cpu|gpu` は
GA バッチ用の 2 本目にだけ使い、運用の常駐 sidecar は CPU のまま (`ocr-sidecar/README.md`)。

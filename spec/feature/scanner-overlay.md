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
| analyze | ロックオン + 偽 YOLO ノイズ箱 + **精度替え再スキャン (下記)** | 同上 + noise 箱 + probe マーカー |
| result | CONFIRMED スタンプ | OCR 値を比率領域に充填 |
| locate | 再スキャンライン (紫) | — (fieldLocator 実行中) |
| **confirm** | **余韻スロースキャン (5 秒) + 本物 BB + 離れたコールアウト** | **fieldLocator が返す実ピクセル BB (source=real)** |

### analyze 中の精度替え再スキャン演出 (2026-06-12)

OCR-GA が attempt (パラメータ個体) ごとに sidecar OCR を回すのに同期して、
**琥珀色スキャンライン (`sc-evolveline`, `RESCAN_SWEEP_MS`=1.6s) を流し直し、
ライン通過に合わせて検出位置へ probe マーカー (`kind="probe"`, 最大 24 個) を置いていく**。
attempt が進むたび key 差し替えで丸ごとやり直す = 「精度を変えて再スキャン」を可視化。

- マーカーには中間 OCR の**認識テキストを小さく添える** (`sc-probe-text`)。
  LLM 確定前でも読めた情報は出す。確定値は confirm フェーズの callout が出す。
- probe 表示中は偽 YOLO ノイズ箱を引っ込めて混雑を抑える。
- データ経路: `OcrEvolver.evaluateAll` の `EvolutionProgress.lines` →
  `probeRegionsFromLines()` → `ScannerOverlay` の `rescan` prop。
- probe は演出専用。学習データ保存 (source=real 保存経路) には乗らない。

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

### confirm の余韻スロースキャン + 終端演出 (2026-06-12 改訂)
- LLM 解析確定 (locate 完了) 後、**ゆっくりした全体スキャンライン (`sc-finalline`,
  `CONFIRM_SCAN_DURATION_MS`=5s) を 1 本流し、ライン通過に同期して枠を順に出す**。
  - 各枠の delay は `use-scan-pipeline` が y 座標 → 5 秒スキャンの通過時刻に再マップ
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
}
```

### 永続化 (`src/services/training-dataset.ts`)

confirm 時、web は本物 BB を backend に POST → JSONL データセットに追記する。

- 1 レコード = `{ receiptId, imageRef, naturalWidth, naturalHeight, engine, regions: [{ bbox, polygon?, text, label }], ts }`
- 保存先: `app_data/training/receipts/<receiptId>.json` + 追記ログ `app_data/training/regions.jsonl`
- **YOLO 形式エクスポート**: `exportYolo()` が画像コピー + `<class> <cx> <cy> <w> <h>` (正規化) のラベル txt を出力 → C で直接学習に使える。

エンドポイント: `POST /v1/receipts/:id/regions`
- body: `{ engine, naturalWidth, naturalHeight, regions: DetectedRegion[] }`
- `source=real` の領域のみ保存。heuristic/noise は破棄。

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
- `web/src/scanner/paddle-locator.ts` — `PaddleFieldLocator implements FieldLocatorEngine`
  - sidecar を叩いて line BB+text 取得 → OCR fields とマッチングして label 付与
  - 各領域に `source:"real"` + `recognizedText` を付ける
  - **sidecar 未到達時はフォールバック**: `TesseractFieldLocator` → `FallbackFieldLocator`
- 起動: `ocr-sidecar/README.md` 参照 (`uvicorn main:app`、既定 port 17350)
- 環境変数 `QUAESTOR_OCR_SIDECAR_URL` で web/backend が URL を知る

### フォールバック段
```
PaddleFieldLocator (sidecar)  ←本命、正確 BB
  ↓ 失敗
TesseractFieldLocator (ブラウザ、word BB)  ←sidecar 無くても本物 BB
  ↓ 失敗
FallbackFieldLocator (比率推定、BB なし)  ←最終手段、演出のみ
```

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

## 7. OCR パラメータの遺伝的最適化 (OCR-GA、2026-06-11)

LLM(Vision) 検出は遅い。その待機中に画面が暇なので、ローカル OCR (PaddleOCR sidecar) を
パラメータ違いで反復し、LLM 真値(絶対正解)と照合して良いパラメータを残す = 遺伝的最適化。

### 汎用 GA エンジン (再利用可能)
GA ロジックはブラックボックス・アーキテクチャでも使えるよう汎用化:
- `src/services/genetic.ts` — ドメイン非依存。遺伝子スキーマ (number/choice/bool) 駆動で
  `randomGenome / mutate / crossover / nextGeneration` + `GaStore<G>` (key 別集団を JSON 永続)。
- `src/services/ocr-ga.ts` — 汎用 engine の OCR 特化。`OCR_GENE_SCHEMA`
  (detThresh/boxThresh/unclipRatio/limitSideLen/useDilation/dropScore) + `createOcrGaStore`。
- 永続: `app_data/training/ga/<key>.json` (`global` or 店舗別)。

### フロー
1. capture → analyze (LLM 待ち) の間、web `OcrEvolver` が
   `GET /v1/ocr-ga/population` で現世代の個体を取得。
2. 各個体で sidecar `/detect` (genome 付き) を回し候補を蓄積。`OCR EVOLVE GEN g n/N` busy 演出。
3. LLM 真値到着 → 各候補を `fitnessVsTruth` で採点 → `POST /v1/ocr-ga/generation`。
4. backend が エリート保存 + ルーレット選択 + 交叉 + 突然変異で次世代を作り永続 (= GA)。
   良い遺伝子が残り、次レシートの初期集団になる。

### sidecar
`ocr-sidecar/main.py` の `/detect` は `genome` (JSON) を受け、その det/rec パラメータの
PaddleOCR インスタンス (キャッシュ) で実行する。

### 勝ち遺伝子の live 適用
LLM 真値到着で `OcrEvolver.finalize()` が最良候補を選び、その検出を `buildRegions` で
confirm 用 region に変換。`EvolvedFieldLocator` が pipeline の locate で勝ち遺伝子の領域を
返す (出るまで待機、無ければ Chained locator に fallback)。

### 店舗別キー
評価は撮影時点で店舗不明なので `global` プールで実施。世代の記録・永続は
`finalize` 時に **payee 由来キー** + `global` の両方へ行い、店舗ごとに best/履歴を蓄積する。

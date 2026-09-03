# 書類種別とサンプルラベル (scan-document-kinds)

設計書: Castra `spec/plan/2026-09-03-quaestor-scan-diversification-ga-evaluation.md` §2 (スキャンの多様化) と
§3.1 (LLM がラベルを付け、 学習はラベル別に回す)。 ここは実装が `@implements` で指す条項の正本。

撮影画面は 1 つのまま、 撮ったものを **書類種別** で自動分類し、 種別ごとの投入先に流す。 同じ 1 回の
LLM 呼出で、 その画像が OCR 学習の **サンプルとして適切か / 特殊形状か** のラベルも付ける。

語彙の正本は `src/shared/document-kinds.ts` (backend の schema CHECK / prompt / 投入ゲート と web のバッジが同じ定数を読む)。

## SPEC-SCAN-KIND-001 — 書類種別と投入先

- `receipts.doc_kind` は `receipt` / `invoice` / `utility` / `statement` / `handwritten` / `other` の 6 種
  (schema v19、 既定 `receipt`)。 v19 以前の行は `receipt` で埋まる。
- 分類はフィールド抽出と **同じ 1 回の LLM 呼出** で行う (`claude -p` と Anthropic SDK の両 OCR 経路が
  `kind` を含む JSON を返す)。 種別ごとに prompt を分けた 2 段呼出にはしない。 確信度が低ければ `other`。
- 種別固有フィールドは `receipts.kind_fields` (JSON、 `src/shared/receipt-kind-fields.ts` の形):
  invoice = issuer / due_date / invoice_no、 utility = supplier / period_from / period_to / usage、
  statement = rows[] (date / description / amount)。 receipt / handwritten / other は持たない。
- 投入の可否は `src/services/receipt-commit.ts` に集約したまま、 種別で方針を切り替える:

  | doc_kind | 自動投入 (OCR 完了時) | 手動投入 (POST /commit) | 理由コード |
  | --- | --- | --- | --- |
  | receipt | 現行どおり (日付-場所-金額 完備 + 非重複) | 同左 | `incomplete` / `duplicate` |
  | handwritten | しない (要確認に残す) | receipt と同じ条件で可 | `needs_review` |
  | invoice / utility / statement / other | しない | しない (種別を直してから投入) | `kind_not_auto_committed:<kind>` |

  invoice / utility / statement の投入先 (仕訳 / 固定費 / 明細取込) への配線は次版 (設計書 A-1 / A-3)。
- 種別ごとの重複キーは `src/services/receipt-duplicate-keys.ts` に置く (receipt / handwritten = 日付-場所-金額、
  invoice = issuer + invoice_no、 utility = supplier + 使用期間)。 投入ゲートが使うのは receipt 系だけ。
- web: スキャン演出の CONFIRMED スタンプと SCAN COMPLETE サマリーに **種別バッジ** (レシート / 請求書 /
  検針票 / 明細 / 手書き / その他) を出す。 撮影一覧 (ShotCard) とレシート一覧 (Receipts) にも種別を出す。
  投入先が未配線の種別は投入ボタンを押せない。 「撮影対象と自動仕訳」 パネルは静的文でなく
  **種別ごとの投入先** の一覧 (語彙から生成) にする。

## SPEC-SCAN-KIND-002 — LLM サンプルラベル

- 同じ LLM 呼出で `sample` を返させ、 receipts に保存する (schema v19):
  - `sample_role`: `good_sample` (全体が写り、 日付・店名・金額が判読でき、 標準的なレイアウト) /
    `special_shape` (長尺・折れ・退色・回転・手書き・多段組・光沢・切れ など) / `none` (学習に使わない)。
    NULL = 未ラベル。
  - `sample_tags`: 形状タグの JSON 配列 (long / folded / faded / rotated / handwritten / multi_column / glare /
    cropped / low_light / wide_paper …)。 `special_shape` は 1 つ以上。 タグは英小文字 snake_case に正規化する。
  - `sample_reason`: 一言 (人が一覧で見るため)。 `sample_source`: `llm` / `manual`。
  - `content_tags`: 内容タグの JSON 配列 (medical / transport / food / daily …)。 種別への昇格は下流ができてから。
- Anthropic SDK 経路も `claude -p` 経路と同じ分類基準を使い、 抽出結果を保存してから種別別の投入ゲートを通す。
  SDK 応答に分類が無ければ、 `doc_kind='receipt'` の既定値で誤投入せず OCR 失敗として要再処理にする。
- `PATCH /v1/receipts/:id/ocr` は `kind` / `kind_fields` / `sample` / `content_tags` を同じ payload で受けて保存する
  (`sample_source='llm'`)。 これらを含まない旧 payload は従来どおりフィールドだけ更新し、 ラベルは触らない。
- 人手上書き済 (`sample_source='manual'`) のレシートは、 その後の LLM 再解析でラベルを上書きしない。
- web: CONFIRMED / サマリーに sample_role (適切 / 特殊形状 / —) を種別バッジと並べて出す。 撮影一覧・レシート
  一覧にラベルとタグを出す。

## SPEC-SCAN-KIND-003 — 人手上書き

- `PATCH /v1/receipts/:id/labels { doc_kind?, sample_role?, sample_tags?, sample_reason?, content_tags? }` で
  上書きし、 `sample_source='manual'` にする。 項目が 1 つも無ければ 400。 種別を変えたときは旧種別の
  `kind_fields` を消す。
- web: 撮影一覧・レシート一覧のバッジをタップするとチップ列 (種別 6 / サンプル 3 / 形状タグ / 内容タグ) が
  開き、 チップ 1 タップで上書きする。 上書き済は ✍ で示す。 直した種別が receipt なら、 その場で投入できる。

## SPEC-SCAN-KIND-004 — 既存レシートのラベル後付け CLI

- `npm run sample:label` (`src/cli/sample-label.ts` → `src/services/sample-labeler.ts`)。
- 母集団: `sample_role IS NULL`、 `sample_source != 'manual'`、 画像あり、 OCR 済み (done / manual / failed) の
  receipts を撮影順に。 人手で種別だけ直して sample_role が NULL の行も対象外にする。
  pending / processing は OCR 完了時にラベルが付くので含めない。
- 1 件ずつ直列に `claude -p` (`quaestor.config.json` の `ocrClaudeCode.model` に固定、 `--allowedTools Read`) へ
  画像と「kind と sample だけ返せ」 の prompt を渡し、 `applyLlmLabels` で書き戻す。 fields は再抽出しない。
- 中断再開可: 既ラベル (と人手上書き済) はスキップされるので、 再実行すれば続きから進む。
  LLM 応答が語彙外 / 例外のものは書かずに次へ進み、 終了コード 2 で件数を報告する (再実行で再試行)。
- `--limit N` / `--dry-run` (LLM を呼ばず対象を列挙) / `--db <path>`。 DB が無ければ作らず失敗する。
- runner は DI (テストはモック)。 本番 DB に対する実行は運用者が行う。

## 実装の置き場所

| 条項 | 実装 | テスト |
| --- | --- | --- |
| 語彙 (6 種 / ラベル / タグ) | `src/shared/document-kinds.ts`、 `src/shared/receipt-kind-fields.ts` | `tests/receipt-commit-kinds.test.ts` |
| schema v19 / 読み書き | `src/db/schema.ts`、 `src/db/receipts-repo.ts` | `tests/scan-document-kinds.test.ts` |
| SPEC-SCAN-KIND-001 投入ゲート・重複キー | `src/services/receipt-commit.ts`、 `src/services/receipt-duplicate-keys.ts`、 `src/services/receipt-intake.ts` | `tests/receipt-commit-kinds.test.ts` |
| SPEC-SCAN-KIND-001/002 OCR prompt | `src/services/ocr-classification-prompt.ts`、 `src/services/claude-code-ocr.ts`、 `src/services/ocr-client.ts`、 `src/services/ocr-runner.ts` | `tests/receipt-commit-kinds.test.ts`、 `tests/ocr.test.ts` |
| SPEC-SCAN-KIND-002/003 ラベル適用・API | `src/services/receipt-labels.ts`、 `src/api/receipts.ts` | `tests/scan-document-kinds.test.ts` |
| SPEC-SCAN-KIND-004 後付け CLI | `src/services/sample-labeler.ts`、 `src/cli/sample-label.ts`、 `src/services/claude-cli.ts` (`--model` / `--allowedTools`) | `tests/sample-labeler.test.ts` |
| web バッジ (CONFIRMED / サマリー) | `web/src/scanner/ScannerOverlay.tsx`、 `web/src/scanner/ScannerSummary.tsx`、 `web/src/scanner/types.ts` (ScanBadge)、 `web/src/scan/scan-badges.ts` | — |
| web ラベル表示・上書き | `web/src/scan/DocKindLabels.tsx`、 `web/src/scan/DocKindLabels.css`、 `web/src/scan/receiptLabelsApi.ts`、 `web/src/scan/ManualShutter.tsx`、 `web/src/pages/Receipts.tsx` | — |
| web 撮影対象パネル | `web/src/scan/ScanGuide.tsx`、 `web/src/scan/ScanGuide.css` | — |

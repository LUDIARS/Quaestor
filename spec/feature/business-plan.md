# 事業計画レビュー (Business Plan Review)

主目的 = **資金調達** (融資・補助金) のための事業計画を、 書類形式に沿って数字・記述で
作成し、 **定量検算 (純関数)** と **定性レビュー (Claude)** の両面でレビューする機能。

既存の会計データ (`transactions` / `invoices` / `financial_statements`) と地続きで、
過去実績を計画のベースラインに取り込める。 補助金情報そのものの管理 (募集要項 DB) は
次フェーズ (本 spec の範囲外)。

## 全体像

```
書類テンプレート (templates.ts)
  ├─ 記述セクション (key/title/hint)      → business_plan_sections
  └─ 数字スペック (category/label/periods) → business_plan_figures
                                              │
実績取り込み (plan-actuals.ts) ──────────────┤  financial_statements / invoices から baseline
                                              ▼
レビュー  ┌─ 定量検算 (quant.ts, 純関数) ── 損益分岐 / 資金ショート / 自己資金比率 / 返済余力
          └─ 定性レビュー (plan-reviewer.ts, Claude) ── 記述と数字の整合 / 不足項目 / 資金調達観点
                                              ▼
                                      business_plan_reviews (findings + score)
```

## テンプレート (書類形式)

`src/business-plan/templates.ts` が正本。 各テンプレが「必要な記述項目」と「必要な数字」を宣言する。

| id | 名称 | 主目的 |
|---|---|---|
| `jfc_startup` | 日本政策金融公庫 創業計画書 | 融資 |
| `jizokuka` | 小規模事業者持続化補助金 経営計画書 | 補助金 |
| `monodukuri` | ものづくり補助金 事業計画書 | 補助金 |
| `freeform` | 自由形式 (3期 P&L + 資金繰り) | 汎用 |

数字カテゴリは全テンプレ共通の語彙を使い、 定量エンジンが統一的に解釈する:

| category | 意味 | periods |
|---|---|---|
| `sales` | 売上高 | years (Y1..Yn) |
| `cogs` | 売上原価 | years |
| `sga` | 販管費 (人件費・家賃・経費等を label で分ける) | years |
| `fixed_cost` | 固定費 (任意。 無ければ break-even は sga を固定費扱い) | years |
| `use_of_funds` | 資金使途 (設備資金 / 運転資金 / 補助対象経費) | single |
| `funding` | 資金調達 (自己資金 / 借入 / 補助金交付額) | single |
| `repayment` | 年間返済額 | years |
| `cashflow` | 月次純増減 (label `期首残高` period `base` で開始残高) | months (M1..M12) |
| `value_added` | 付加価値額 (= 営業利益+人件費+減価償却費。 ものづくり用) | years |
| `labor_cost` / `depreciation` | 人件費 / 減価償却費 (付加価値内訳) | years |

`periods` の意味:
- `years`: `Y1`..`Y{horizon}` (計画年数)。 JFC の「創業当初 / 軌道に乗った後」は Y1/Y2 に対応
- `months`: `M1`..`M12` (初年度資金繰り)
- `single`: `base` 1 値

## データモデル

```sql
business_plans(id TEXT PK, name, template, purpose, status, fiscal_start, horizon_years, notes, metadata, ...)
business_plan_sections(id, plan_id FK, key, body, display_order, UNIQUE(plan_id,key))
business_plan_figures(id, plan_id FK, category, label, period, amount, source, UNIQUE(plan_id,category,label,period))
business_plan_reviews(id, plan_id FK, kind, score, summary, findings JSON, metrics JSON, model, created_at)
```

- `purpose`: `funding` (融資) / `subsidy` (補助金) / `internal`
- `status`: `draft` / `review` / `final`
- 金額は整数 (円)。 plan 作成時に template 定義から sections / figures の空行を seed する

## 定量検算 (quant.ts — 純関数・LLM 不要)

figure 行配列を受けて metrics と findings を返す。 主な指標:

- **年次 P&L**: 売上 − 原価 = 粗利、 粗利 − 販管費 = 営業利益、 営業利益率
- **損益分岐点**: 固定費 / (1 − 変動費率)。 変動費率 = 原価/売上。 Y1 を対象
- **資金調達バランス**: Σ調達 = Σ使途 か。 自己資金比率 = 自己資金 / Σ調達 (公庫目安 1/10)
- **返済余力**: 営業利益 / 年間返済額 (< 1 で警告)
- **資金繰り**: 期首残高 + 月次純増減の累積。 1 度でもマイナス → 資金ショート (該当月を報告)
- **付加価値額成長** (ものづくり): 年率 +3% を満たすか

findings は `{ severity: error|warning|info, area, code, message, suggestion }`。
定量スコア = 100 − (error×25 + warning×10 + info×3)、 0..100 clamp。

## 定性レビュー (plan-reviewer.ts — Claude tool_use)

`security-mapper.ts` と同じ DI 流儀: `PlanReviewer` interface + 2 つの実装。
`buildApp` の `resolvePlanReviewer` が `"auto" | "disabled"` を解決し、
**① ANTHROPIC_API_KEY あり → `ClaudePlanReviewer` (SDK, model=sonnet)**、
**② key 無しでも claude CLI あり → `ClaudeCliPlanReviewer` (サブスク, `claude -p --output-format json`)** の順に選ぶ。
これにより API キー無しのサブスク環境でも定性レビューが動く (`QUAESTOR_PLAN_REVIEWER_CLI_DISABLE=1` で②を無効化)。
CLI 版は tool_use の代わりに「厳密 JSON のみ出力」を指示し、 stdout エンベロープ
(単一オブジェクト / イベント配列 / NDJSON のいずれも) から result を取り出して `normalizeReview` で正規化する。

入力 = 記述セクション全文 + 数字サマリ (定量 metrics)。 出力 (tool_use 強制):
- `score` 0..100
- `summary` 総評
- `findings[]` `{ severity, area(section key 等), message, suggestion }`

観点: 記述と数字の整合性 / 不足・薄い項目 / 資金調達 (融資・補助金) の通りやすさ / 強み弱みの説得力。
送信するのは事業計画の記述と集計数字のみ (個人の口座番号等は送らない)。

## API (`/v1/business-plans`)

| method path | 用途 |
|---|---|
| `GET /templates` | テンプレート定義一覧 |
| `GET /` | 計画一覧 |
| `POST /` | 計画作成 (template から sections/figures を seed) |
| `GET /:id` | 計画詳細 (sections + figures + 最新 review) |
| `PATCH /:id` | メタ更新 (name/purpose/status/notes/...) |
| `DELETE /:id` | 削除 |
| `PUT /:id/sections/:key` | 記述セクション本文 upsert |
| `PUT /:id/figures` | 数字 bulk upsert |
| `POST /:id/seed-from-actuals` | 実績 (前年 financial_statements) を baseline に取り込み |
| `GET /:id/variance` | 計画 vs 実績 差異分析 (fiscal_start 起点の年度窓で突合) |
| `GET /:id/export.xlsx` | 事業計画を Excel (概要/記述/数字/検算 の4シート) で出力 |
| `POST /:id/review` | レビュー実行 (`?kind=quantitative\|qualitative\|combined`)、 結果を永続 |
| `GET /:id/reviews` | レビュー履歴 |

### 計画 vs 実績 差異分析 (`variance.ts`)

`fiscal_start` (yyyy-mm) を起点に各年度を 12ヶ月のカレンダー窓に割り当て、 窓が経過 (or 進行中) なら
実績と突合する。 実績 = 売上 (`invoices` の amount、 cancelled 除く) / 経費 (`transactions` の amount_out、
振替除く)。 計画売上・利益との差異と達成率を年度ごとに返す。 純計算は `src/business-plan/variance.ts`、
DB 集計は `computePlanVariance` (service)。 未到来の窓は `elapsed=false` で表示側が判別。

## フロントエンド

`web/src/pages/BusinessPlan.tsx` + nav タブ「事業計画」。

- 計画一覧 + テンプレ選択して新規作成
- 計画エディタ: 記述セクション (`.foundation-form` textarea) + 数字テーブル (年次 / 資金調達 / 月次資金繰り)
- 「実績から取り込み」ボタン / 開始年月 (fiscal_start) 設定
- 「レビュー実行」→ 定量メトリクス (損益分岐・資金ショート警告・自己資金比率) + 定性 findings (severity バッジ) + スコア
- 「計画vs実績 差異分析」→ 年度ごとの計画/実績売上・達成率・利益テーブル

## 個人データ・セキュリティ

- DB は既存 `app_data/quaestor.db` に同居。 ローカル完結
- 定性レビューで Claude に送るのは事業計画の記述と集計数字のみ。 口座番号・個人特定情報は送らない
- レビューは POST 操作でのみ外部 (Claude) アクセス。 GET は DB キャッシュ (保存済 review) を返す

## 補助金情報の管理 + 要件マッチング (`subsidies`)

補助金・助成金・制度融資を手動登録し (`subsidies` テーブル、 名称/実施機関/対象者/要件/上限額/補助率/締切/status)、
事業計画との要件マッチングにかける。 API `/v1/subsidies` (CRUD) + `POST /v1/subsidies/match` (body `{plan_id}`)。

マッチングは `subsidy-matcher.ts` (`ClaudeSubsidyMatcher`、 claude-cli.ts 経由でサブスク auth、 API key 不要)。
計画の記述+数字サマリ (`buildPlanSummaryText`) と open な補助金リストを Claude に渡し、 各補助金の
fit (high/medium/low) と根拠を JSON 配列で返す。 候補 id 集合に無いものは捨て、 fit 高い順に並べる。
web 「補助金」タブで CRUD + 計画選択 → マッチング診断。

### 自動収集 (クロール) + サジェスト (`subsidy-crawler.ts` / `subsidy-advisor.ts`)

補助金データを **jGrants 公開 API** (`api.jgrants-portal.go.jp/exp/v1/public/subsidies`、 鍵不要) から自動収集する。
`JGrantsCrawler` が keyword 検索 (一覧、 acceptance=1 で募集中のみ) → 各件の詳細 API で enrich (補助率/要件/対象) →
Quaestor の subsidy 形式に正規化 (`normalize`、 補助率テキストは `parseRate` で 0..1 に)。 `fetchImpl` を DI してテスト。

- `POST /v1/subsidies/crawl` {keyword} → 候補プレビュー (保存しない、 `already_saved` フラグ付き)
- `POST /v1/subsidies/import` {candidates} → subsidies に取込 (`metadata.jgrants_id` で重複防止)
- `POST /v1/subsidies/suggest` {plan_id, keywords?} → `suggest-advisor`: 計画からキーワード導出 (claude CLI、
  省略時) → jGrants クロール → dedup → matcher でランク → fit 順に提案。 web 「jGrants から検索/提案」+取込ボタン。

## 今後 (本 spec 外)

- 補助金データ収集源の拡張 (現状 jGrants のみ。 ミラサポ plus・自治体個別等の追加)
- クロール候補の定期取込 (cron で open 補助金を自動更新、 締切切れの自動 close)
- 公式様式への流し込み (公庫・補助金の指定 Excel/PDF テンプレートへのマッピング。 現状は汎用4シート出力)
- 差異分析の月次粒度化 (現状は年度窓。 月次トラッキングは未対応)

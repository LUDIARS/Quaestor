# 積立ポートフォリオ / 配当アドバイザ (Portfolio Advisor)

今契約している「積立の投資型」商品 (つみたてNISA / 投資信託・個別株 / ETF・変額 / 外貨建保険)
を Quaestor で一元管理し、 **利回り・将来見通し・配当株サジェスト** を提示する機能。

> コンセプト: 「いくら積んで、 いくらになって、 このまま行くとどうなるか」 を 1 画面で。
> 既存の [invest-advisor](./invest-advisor.md) (消費行動 → 株主優待) とは別レイヤーで、
> こちらは **自分の保有資産そのもの** を入力源にする。

## 位置づけ

家計簿/取引データの上ではなく、 **明示的に登録した保有商品** を入力源とする分析層。
invest-advisor とは株価インフラ (stooq `StockClient` / `securities` / `stock_quotes`) を共有する。

## 対象商品 (kind)

| kind | 例 | 時価の取得方法 |
|---|---|---|
| `fund` | つみたてNISA / 投資信託 | **手動** (基準価額ベースの評価額を入力)。 stooq 非対応 |
| `stock` | 個別株 | 証券コード → **stooq 自動** (終値 × 保有株数) |
| `etf` | ETF | 同上 |
| `insurance` | 変額保険 / 外貨建保険 | **手動** (解約返戻金/評価額。 外貨建は `fx_rate` で円換算) |
| `other` | 持株会・その他 | 手動 |

## データモデル (SQLite, user_version=7)

| テーブル | 役割 |
|---|---|
| `holdings` | 保有商品マスタ (kind / 口座 / ticker / 税制枠 / 目標額 / 計画積立額 / status) |
| `contributions` | 拠出の **計画/実績** (plan/actual)。 plan-variance と XIRR の入力 |
| `holding_valuations` | 時価スナップショット (手動 or stooq)。 1 holding × as_of |
| `holding_dividends` | 受取分配金/配当 (再投資フラグ付き)。 トータルリターン |
| `dividend_candidates` | 配当株サジェストのキャッシュ (公開情報のみ。 1 ticker = 1 行) |

`contributions.amount` は投資家視点の拠出 (入金=正、 取崩し=負)。 金額は円 (整数)。

## 計算ロジック

### 利回り (`services/portfolio-return.ts`, 純関数)

- **取得原価 (invested)** = actual 拠出の純額
- **含み損益** = 直近評価額 − invested
- **トータルリターン** = 含み損益 + 受取配当 (再投資しない分)
- **単純利回り %** = トータルリターン / invested
- **年率 (XIRR)** = 不定期 cashflow (拠出=負, 非再投資配当=正, 終端評価額=正) の内部収益率。
  Newton 法 → 二分法フォールバックで解く。 積立は periodic in/out なので XIRR が妥当な年率指標。

### 計画 vs 実績 (plan-variance)

- `planned_to_date` = `planned` 拠出行の合計 (基準日まで)。 行が無ければ `monthly_contribution × (経過月数 + 1)` で合成
  (起算月に第1回を拠出する月次積立として数えるため開始月を含む。 例: 12/1 開始を 6/18 に見ると 7 回)
- `actual_to_date` = `actual` 拠出の合計 (基準日まで)
- `variance` = actual − planned (マイナス = 計画より積めていない)

### 将来見通し (`services/portfolio-projection.ts`, 純関数)

現在評価額 + 毎月の積立を月次複利で投影。 不確実性は **保守/中立/楽観 の 3 シナリオ**
(既定 年率 1% / 4% / 7%、 呼び出し側で上書き可) で表現する。 目標額に到達する月も算出。
モンテカルロは将来拡張。

## 配当株サジェスト (`services/dividend-client.ts`)

`DividendClient` interface + `ClaudeDividendClient` (Anthropic tool_use)。 perk-client と同型。
配当利回り / 1株配当 / 配当性向 / 連続増配年数 / 権利確定月 / 安定性所見 を取得し
`dividend_candidates` にキャッシュ (鮮度は `fetched_at`)。

### ★ インサイダー方針 (重要)

- 参照するのは **公開済 IR・有価証券報告書・適時開示・過去の配当実績** など一般に入手可能な情報のみ。
- **未公表の決算/業績予想変更/増配減配の内部決定/M&A 等の重要事実 (MNPI) は扱わない・推測しない。**
- 出力は **情報提示であり投資助言ではない**。 不確実な項目は null にし「最新は各社 IR で要確認」を明記。
- system prompt にこの制約を明文化し、 UI にも免責を常時表示する。

## API `/v1/portfolio` (`api/portfolio.ts`)

| method | path | 内容 |
|---|---|---|
| GET | `/summary` | 全 holding の利回り + ポートフォリオ合計 (`?status&as_of`) |
| GET | `/holdings` | 編集用の生 holding 一覧 |
| POST | `/holdings` | 商品作成 |
| GET | `/holdings/:id` | 明細 (拠出/時価/配当/利回り) |
| PUT | `/holdings/:id` | 部分更新 |
| DELETE | `/holdings/:id` | 削除 (sub-record も CASCADE) |
| POST | `/holdings/:id/contributions` | 拠出 (計画/実績) 追加 |
| POST | `/holdings/:id/valuations` | 時価スナップショット (手動) |
| POST | `/holdings/:id/dividends` | 受取配当/分配金 追加 |
| DELETE | `/contributions/:cid` ・ `/dividends/:did` | 個別削除 |
| GET | `/projection` | 将来見通し (`?holding_id` 個別 / 無指定で全体, `?years`) |
| POST | `/valuations/refresh` | 個別株/ETF の時価を stooq 更新 (`{holding_ids?}`) |
| GET | `/dividends/candidates` | 配当株サジェスト一覧 (株価結合) |
| POST | `/dividends/suggest` | Claude で配当の公開データ取得・キャッシュ (`{tickers?}`) |

外部アクセス (stooq / Claude) は POST refresh/suggest に限定。 GET は DB キャッシュのみ。

## 依存・設定

- 株価: stooq (登録不要)。 invest-advisor と共有。
- 配当データ: `ANTHROPIC_API_KEY` (OCR と同じ鍵)。 未設定なら `/dividends/suggest` は 503。
- 既定 model: `claude-sonnet-4-6` (知識精度が要るため)。

## 個人データ

保有商品・拠出額・評価額はローカル DB 内で完結。 外部へ送るのは **証券コードと会社名のみ**
(配当データ取得時)。 金額・口座・保有量は送らない ([[project_personal_data_rule]] と整合)。

## フロントエンド (`web/src/pages/Portfolio.tsx`)

「積立/資産」タブ。 ポートフォリオ合計サマリ + 保有商品カード (利回り/計画比/記録追加) +
将来見通し (3 シナリオ終端 + base ライン) + 配当株サジェスト (免責付き)。

## 段階 (prototyping-flow: まず粗く動かす)

- v0.1 ✅ backend: schema + 5 repos + portfolio-return(XIRR) + projection + dividend-client + service + API + 24 tests
- v0.1 ✅ web: 積立/資産タブ (合計/保有カード/記録追加/見通し/配当サジェスト)
- 後続: 投信基準価額の半自動取得 (商品名→Claude/外部API) / 保険証券 PDF 取込 / モンテカルロ /
  税制枠 (NISA 非課税枠・iDeCo 上限) の残枠管理 / 定期 refresh worker

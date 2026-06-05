# 投資 / 優待アドバイザ (Invest Advisor)

レシート OCR + 取引照合で蓄えた **行動データ** から「自分がよく使う店・商品」を
洗い出し、その運営企業の **株価動向** と **株主優待** を提示する機能。

> コンセプト: 「どうせ使う店なら株主になって優待で得をしろ」を消費行動から逆算で提案する。

## 位置づけ

Quaestor 本体機能 (レシート / 取引 / 照合 / 請求書 / ダッシュボード) の上に乗る分析層。
新規のデータ収集はせず、既存の `receipts` (投入済) + `transactions` を入力源にする。

## パイプライン

```
[行動解析]            [銘柄マッピング]         [市場データ取得]          [統合提案]
receipts + tx   →    payee → 上場企業 →   →   株価 (stooq)         →   よく使う店 X
を payee で集計        証券コード (Claude)       優待 (Claude)            → 銘柄 Y / 株価 Z
頻度・累計支出                                                            → 優待 W (利回り V%)
```

1. **行動解析** `services/behavior-analysis.ts`
   - `transactions` (is_transfer=0, amount_out) を主入力に、 未 reconcile の committed
     `receipts` を補完して `normalizePayee` キーで集約 → 訪問回数 + 累計支出のランキング。
   - **クレカ明細が主供給源**。 `source` フィルタ (`credit-card`/`bank`/…) で絞れる。
     source 指定時はその tx のみ (receipts 除外)。
   - **月次取込対応**: クレカは「先月分を当月取込」と 1 ヶ月遅れ。 from/to 未指定なら
     `dataCoverage` の最終月から `months` (既定 6) 遡った窓を既定にし当月の空データを除外。
     `resolveRange` が窓を解決し `/behavior`・`/suggestions` は適用期間 + coverage を返す。
   - 出力: `{ payee_norm, payee_sample, visits, total_spend, sources[] }`

2. **銘柄マッピング** `services/security-mapper.ts`
   - `SecurityMapper` interface。実装 `ClaudeSecurityMapper` (Anthropic tool_use)。
   - 店名 → 運営企業 → 証券コード (4 桁) を推定。非上場・該当なしも明示。
   - 結果は `payee_securities` にキャッシュ (1 payee = 1 行)。再解析は明示時のみ。

3. **市場データ取得**
   - `services/stock-client.ts` — `StockClient` interface + `StooqStockClient`。
     - stooq 日足 CSV (`https://stooq.com/q/d/l/?s=<code>.jp&i=d`) を取得し、
       最新終値 + 期間騰落率 + 直近 N 本 (sparkline) を返す。
     - **後で J-Quants 等へ差し替え可能**にするため interface 化。
   - `services/perk-client.ts` — `PerkClient` interface + `ClaudePerkClient` (Anthropic tool_use)。
     - 銘柄の優待制度 (有無 / 必要株数 / 内容 / 権利確定月 / 概算価値 / 優待利回り) を取得。
     - 公式 API が無い領域なので LLM 知識ベース。鮮度は `fetched_at` で管理。

4. **統合提案** `services/invest-advisor.ts`
   - 上記をオーケストレーションし、行動ランキング × 銘柄 × 株価 × 優待を結合した
     「提案」リストを生成する。優待利回りや「あと N 株で優待圏」を計算する余地を残す。

## データモデル (SQLite, schema.ts user_version=4)

| テーブル | 役割 |
|---|---|
| `securities` | 銘柄マスタ (ticker=証券コード PK, name, market) |
| `payee_securities` | 店名(正規化) → 銘柄リンク + relation/confidence/reason (Claude or manual) |
| `stock_quotes` | 株価スナップショット (ticker × as_of, 終値/騰落率/直近足 JSON) |
| `shareholder_perks` | 株主優待 (ticker, 必要株数/内容/権利確定月/価値/利回り) |

`payee_securities.ticker` は NULL 可 = 「解析したが上場該当なし」を表現 (relation='none')。

## API `/v1/invest` (`api/invest.ts`)

| method | path | 内容 |
|---|---|---|
| GET | `/behavior` | 行動解析ランキング (`?from&to&limit&min_visits`) |
| GET | `/securities` | マッピング済銘柄 + リンク payee 一覧 |
| POST | `/map` | 未マッピングの上位 payee を Claude で解析しキャッシュ (`{limit, from, to}`) |
| PUT | `/map/:payee_norm` | 手動でマッピングを上書き (ticker/relation 指定) |
| POST | `/quotes/refresh` | マッピング済 ticker の株価を stooq から取得・更新 (`{tickers?, period_days?}`) |
| POST | `/perks/refresh` | マッピング済 ticker の優待を Claude で取得・更新 (`{tickers?}`) |
| GET | `/suggestions` | 統合ビュー (行動 × 銘柄 × 株価 × 優待) |

LLM/stooq へのアクセスは server からのバッチ操作 (POST refresh) に限定し、
GET は DB キャッシュのみを返す (UI のレイテンシ確保)。

## 依存・設定

- 株価: stooq (登録不要, ネットワークアクセスのみ)。`STOOQ_BASE_URL` で差し替え可 (テスト用)。
- 銘柄マッピング / 優待: `ANTHROPIC_API_KEY` 必須 (OCR と同じ鍵)。未設定なら該当 POST は 503。
- 既定 model: マッピング/優待は知識精度が要るため `claude-sonnet-4-6` (OCR の Haiku より上)。

## 個人データ

行動解析は既存ローカル DB 内で完結。外部へ送るのは
**店名文字列 (マッピング時) / 会社名 (優待取得時)** のみで、金額・日付・個人情報は送らない。
([[project_personal_data_rule]] と整合: 取引データはローカル完結, 送信は店名のみ)

## 段階 (prototyping-flow: まず粗く動かす)

- v0.1 ✅ backend: schema + repos + behavior-analysis + StooqStockClient + ClaudeSecurityMapper/PerkClient + invest-advisor + API + tests
- v0.1 web: Invest タブ (行動ランキング / マッピング / 提案カード)
- 後続: 優待利回り計算精緻化 / 「あと N 株で優待圏」/ J-Quants 差し替え / 定期 refresh worker

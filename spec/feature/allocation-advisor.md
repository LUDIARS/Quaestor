# 資産配分アドバイザー

現在のポートフォリオから、 **目標とする資産配分・投資幅・具体的な金融資産** を論拠付きで提案する。
提案は Claude (claude-cli、 サブスク auth、 API key 不要) で生成。

## 流れ

```
PortfolioService.summary(asOf)         保有 + 評価額
  → buildPortfolioSnapshot (純関数)    資産クラス別 / 税制枠別の配分%・保有一覧
  → ClaudeAllocationAdvisor.recommend  目標配分 / 投資幅 / 金融資産アイデアを JSON で生成
  → AllocationAdviceStore (JSON file)  最新 1 件をキャッシュ (LLM 再実行を避ける)
```

## 入力 (profile)

- `risk`: conservative / balanced / aggressive
- `goal`: 目標 (例「20年で老後資金2000万」)
- `monthly_budget`: 毎月投資に回せる額の上限目安

## 出力 (AllocationAdvice)

- `summary`: 総評・方針
- `target_allocation[]`: `{ asset_class, current_pct, target_pct, action(increase/decrease/hold), rationale }`
- `investment_capacity`: `{ suggested_monthly, note }` = 投資幅 (追加で回せる額と論拠)
- `asset_ideas[]`: `{ name, kind, tax_wrapper, rationale }` = 具体的な金融資産候補

LLM には資産クラス別の集計・保有名・税制枠のみを渡す (口座番号等は送らない)。
日本の税制 (NISA つみたて/成長投資枠・iDeCo・課税口座) を踏まえ、 非課税枠の活用を優先的に検討させる。
特定銘柄の断定的売買推奨は避け、 資産クラス配分とカテゴリ (インデックス投信等) を中心に論拠を必須にする。

## API (`/v1/portfolio`)

| method path | 用途 |
|---|---|
| `POST /allocation/recommend` | 現ポートフォリオから提案を生成しキャッシュ (body: as_of/risk/goal/monthly_budget) |
| `GET /allocation` | 最新キャッシュを返す (無ければ `available:false`) |

claude CLI が無ければ `{disabled:true}`、 保有ゼロなら 400。

## web

「積立/資産」タブ上部の `AllocationPanel`。 リスク/目標/月の余力を入力 → 「提案する」→
目標配分テーブル (現状→目標 + 増減 + 論拠) / 投資幅 / 金融資産アイデアを表示。 起動時に直近キャッシュを読む。

## 今後 (本 spec 外)

- 提案の Discord 通知連携 (notifications の channel に追加)
- 市場データ (利回り・指数) のクロールで論拠を補強

# メニューのカテゴリ化 (Concordia 風) とスマホ用ダッシュボード — 設計書

作成: 2026-09-03 / 対象: Quaestor (Qs) / 状態: 実装済 (同 PR)

## 0. 依頼 (neco)

- メニュー項目が多くなったので、 カテゴリごとに分けて Concordia のメニュー実装と同じような表示にする。
- スマホではトップページをダッシュボード化する: (1) メニューを開くボタン、 (2) よく使うページを上の方にリスト化、 (3) アクティビティログを出す。 PC は今のままでよい。

## 1. Concordia のメニュー (web/src/components/Nav.tsx)

- セクション見出し (小さい大文字ラベル) + 項目リスト。 PC は左サイドバー (折りたたみ可、 折りたたみ状態は localStorage)、 スマホは ☰ ボタンで左からドロワー (背景タップ / Esc / 遷移で閉じる)。
- Tailwind + Foundation トークン (`bg-surface` / `border-border` / `text-subtle` / `bg-muted` / `text-accent`)。 Quaestor も同じトークン定義を持っている。

## 2. 方針

- Quaestor は react-router を使っていない (ページは state) ので、 Concordia の Nav を **`page` state 版に移植** する (`onSelect(key)`)。 見た目・挙動 (セクション / 折りたたみ / ドロワー) は同じ。
- カテゴリ:

| セクション | ページ |
|---|---|
| 記帳 | ダッシュボード / 簿記 / 決算書 / 減価償却 / 按分シート |
| 取込 | スキャン / レシート / 明細取込 / 明細プロファイル / 取引 / 突合 |
| 家計・資産 | 家計分析 / 投資・優待 / 積立・資産 |
| 事業 | 請求書 / 事業計画 / 補助金 |
| 設定 | エクスポート / 設定 |

- **スマホ (幅 < 768px) のトップ** は `MobileHome`: ☰ ボタン (ドロワーを開く)、 よく使うページ (上位 6 件)、 アクティビティログ (直近 30 件)。 PC のトップは従来の Dashboard のまま。 判定は `matchMedia("(max-width: 767px)")`。
- **スマホの年選択** は、データが存在する今年から過去 2 年をタブで表示し、それ以前の年と「全期間」をプルダウンにまとめる。PC の年タブは従来のままにする。
- **よく使うページ** はブラウザ側で数える (`localStorage` `quaestor.page-visits.v1`: key → {count, last})。 ページ遷移ごとに加算し、 count 降順 → last 降順。 履歴が無いときは既定 (スキャン / レシート / 家計分析 / 簿記 / 取引 / 突合)。 端末ごとの個人的な便宜なので DB には持たない。
- **アクティビティログ** は既存テーブルの時刻列から組み立てる (新テーブル無し): 明細取込 (imports + 件数) / レシート撮影・投入 (receipts) / 突合 (reconciliations) / 請求書 (invoices) / 手動仕訳・仕訳取込 (journal_entries、 取込は created_at 秒で束ねる) / 固定資産 (fixed_assets) / 按分ルール (apportionment_rules)。 `GET /v1/activity?limit=` で時刻降順。 ローカル UI に必要な金額・店名・取引先名は表示する一方、取込元ファイル名は返さず、応答は `Cache-Control: no-store` とする。

## 3. 実装

| ファイル | 責務 |
|---|---|
| `src/services/activity-log.ts` | 各テーブルから ActivityEvent[] を集める純クエリ (kind / at / title / detail / page) |
| `src/api/activity.ts` | `GET /v1/activity?limit=` |
| `web/src/lib/pages.ts` | ページ定義 (key / label / section) を 1 箇所に |
| `web/src/lib/page-visits.ts` | 訪問回数の記録と上位取得 (localStorage) |
| `web/src/lib/useMediaQuery.ts` | matchMedia フック |
| `web/src/components/Nav.tsx` | Concordia 風のサイドバー + ドロワー (page state 版) |
| `web/src/components/YearTabs.tsx` | スマホ用の省スペースな年タブ + 過去年プルダウン |
| `web/src/pages/MobileHome.tsx` | スマホのトップ (メニューボタン / よく使うページ / アクティビティログ) |
| `web/src/App.tsx` | header + Nav + main のレイアウト。 スマホでトップなら MobileHome、 それ以外は従来ページ |

## 4. テスト

- `activity-log.test.ts`: 各種イベントが時刻降順で混ざる、 仕訳取込が 1 件に束ねられる、 limit。
- API 疎通は同ファイルで `/v1/activity`。

## 5. 対象外

PC のトップページ変更、 訪問履歴のサーバ保存、 プッシュ通知。

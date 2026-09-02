# メニューのカテゴリ化とスマホ用トップ (mobile-home)

設計書: `spec/plan/2026-09-03-mobile-dashboard-nav.md`。

## SPEC-MOBILE-HOME-001 — メニューはセクション分けし Concordia と同じ表示にする

- ページはセクション (記帳 / 取込 / 家計・資産 / 事業 / 設定) に属し、 PC では左サイドバー (折りたたみ可)、 スマホでは ☰ ボタンからのドロワーで出す。
- 折りたたみ状態は localStorage、 ドロワーは背景タップ / Esc / ページ遷移で閉じる。
- 見た目は Foundation トークン (surface / border / subtle / muted / accent) を使い Concordia の Nav と揃える。

## SPEC-MOBILE-HOME-002 — スマホのトップはダッシュボード

- 幅 767px 以下でトップ (page=dashboard) を開くと、 ☰ ボタン / よく使うページ / アクティビティログ を出す。 PC のトップは従来どおり。
- よく使うページは端末内の訪問回数 (localStorage) の上位 6 件。 履歴が無ければ既定の 6 件。
- アクティビティログは `GET /v1/activity` が既存テーブル (imports / receipts / reconciliations / invoices / journal_entries / fixed_assets / apportionment_rules) から時刻降順・`Cache-Control: no-store` で返す。 仕訳取込は 1 回の取込を 1 件に束ね、取込元ファイル名は応答に含めない。 各項目は該当ページへ遷移できる。

# 請求書の Discord 確認通知

作成された請求書の中身を人が確認するための、Qs → Discord の一方向通知。
既存のアドバイザー通知と同じ webhook (`QUAESTOR_DISCORD_WEBHOOK_URL`) を使う。

## 何を送り、何を送らないか

送るのは突き合わせに要る項目だけ — 請求先 / 状態 / 請求日 / 支払期限 / 請求額 / 摘要 /
備考。**PDF 本体は送らない**。webhook は送信専用で、Qs はファイル配布の主体にならない。
PDF の確認はセッション側のファイル送信が担う。

`invoices.amount` は源泉徴収前の税込総額なので、源泉額が入っているときだけ
`¥99,790 (税込 ¥110,000 − 源泉 ¥10,210)` の形で差引後の入金予定額と内訳を併記する。
差引前と読み違えると入金確認が狂うため、この併記は省略しない。

## 経路

`POST /v1/notify/invoice { invoice_id, dedup? }` → `NotificationService.notifyInvoice`
→ `buildInvoiceNotice` → Discord webhook。

`dedup: true` は定期・自動実行向けで、同じ内容なら送らない。dedup キーは請求書 id と
**状態と金額と更新時刻**から作るので、同じ請求書でも `draft → sent → paid` の遷移は
毎回届く。オンデマンド (dedup 無し) は常に送る。

- SPEC-INVOICE-NOTICE-001 — 存在しない `invoice_id` は送信せず 404 を返す (無言で成功にしない)。
- SPEC-INVOICE-NOTICE-002 — webhook 未設定 (`QUAESTOR_DISCORD_WEBHOOK_URL` 無し) なら送らず
  `disabled` を返す。設定漏れを成功と区別する。
- SPEC-INVOICE-NOTICE-003 — `metadata` が壊れた JSON でも通知は止めない (請求書番号を落として続行)。

---
task: ses-invoice-email
project: Quaestor
kind: 実装
status: pending
created: 2026-08-18
memory_links: []
---

# 請求書メール送信元を Gmail ADC から Amazon SES へ置換する

## 目的

現行 `GmailAdcClient` は運用者の gcloud ADC (authorized_user refresh token) で請求書メールを送るため、
送信本文とマジックリンクが運用者の Gmail「送信済み」に永久保存され、「運用者が送信内容を読めない /
発行済みマジックリンクを特定できない」という要件を満たさない。

Amazon SES (SESv2 `SendEmail`) は送信済み本文を保持せず、イベント発行にも本文が含まれないため、
事後に読み返す経路が構造的に無い。設計書 `spec/plan/2026-08-18-ses-invoice-email.md` に従い、
SES を唯一のメール経路にし、Gmail ADC クライアントを削除する (置換であってリネームではない)。

## 実装内容

- 新規: `src/services/ses-email-client.ts` — SigV4 署名 (`node:crypto`) + `fetch` で SESv2
  `SendEmail` を呼ぶ送信専用クライアント。依存追加なし。
- 削除: `src/services/gmail-adc-client.ts` / `tests/gmail-adc-client.test.ts`
- 変更: `src/services/app-config.ts` — `invoiceShare.email` (region/fromAddress/configurationSet) を
  追加し、`QUAESTOR_SES_REGION` / `QUAESTOR_SES_FROM_ADDRESS` / `QUAESTOR_SES_CONFIGURATION_SET` を
  env override として読む
- 変更: `src/app.ts` — `resolveInvoiceEmailNotifier` を SES ベースに変更 (`"auto"` 明示時のみ実クライアントを
  組み立てる方針は維持)
- 変更: `src/server.ts` — コメント更新のみ
- 変更: `src/services/invoice-email-notifier.ts` / `invoice-email-delivery.ts` /
  `invoice-share-acceptance-service.ts` — 「Gmail」「Gmail ADC」表記を「SES」「Amazon SES」に置換
  (ロジック不変)
- 新規: `tests/ses-email-client.test.ts` — 設定欠落時の 503、送信 happy path、
  configurationSet/sessionToken 指定時のヘッダ、403/500/MessageId欠落/fetch reject のエラー分類、
  署名の決定性、宛先不正の拒否、`sesCredentialsFromEnv` を検証
- 変更: `tests/app-config.test.ts` — `invoiceShare.email` の既定値/ファイル読み込み/env優先を追加
- 変更: `tests/invoice-email-delivery.test.ts` — コメント/テスト名の「Gmail」表記のみ「SES」に置換
  (ロジック不変)

## 完了条件

- [x] 仕様は既に更新済み (`spec/feature/invoice-public-magic-link.md`,
      `spec/setup/config-and-secrets.md` — 本タスクの前提コミット `79e3648` で改訂済み)
- [x] 実装した (上記ファイル一覧のとおり)
- [x] 回帰テストを追加/更新した (`tests/ses-email-client.test.ts` 新規、
      `tests/app-config.test.ts` / `tests/invoice-email-delivery.test.ts` 更新)
- [x] `grep -rn -i "gmail\|GmailAdc\|application_default_credentials\|GOOGLE_APPLICATION_CREDENTIALS" src tests` — 0件
      (コメント内の "AWS_ACCESS_KEY_ID を読まない" という説明文以外に個人プロファイル読み取りなし)
- [x] `gmail-adc-client.ts` / `gmail-adc-client.test.ts` が存在しない
- [x] `SesEmailClient` が `src/app.ts` に import + 組み立ての2箇所以上で参照される
- [x] `sesCredentialsFromEnv` が `src/app.ts` と `src/services/ses-email-client.ts` の両方にある
- [x] `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_PROFILE` の実読み取りがない
      (grep 1件ヒットは「読まない」と書いた説明コメントのみ)
- [x] `package.json` に `@aws-sdk` 系の依存が追加されていない
- [x] `npx tsc --noEmit -p tsconfig.json` が 0 error
      (`noUncheckedIndexedAccess` により `signRequest` 内の `headers[name]` アクセスへ
      `?? ""` フォールバックを1箇所追加。設計書 §3 コードの型エラー修正であり、ロジック変更ではない)
- [x] 変更を commit した

## スコープ (編集可ディレクトリ)

`src/services/ses-email-client.ts` (新規), `src/services/gmail-adc-client.ts` (削除),
`src/services/app-config.ts`, `src/app.ts`, `src/server.ts`,
`src/services/invoice-email-notifier.ts`, `src/services/invoice-email-delivery.ts`,
`src/services/invoice-share-acceptance-service.ts`,
`tests/ses-email-client.test.ts` (新規), `tests/gmail-adc-client.test.ts` (削除),
`tests/app-config.test.ts`, `tests/invoice-email-delivery.test.ts`。
`web/` は対象外。依存追加・lockfile 変更は対象外。

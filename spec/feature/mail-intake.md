# mail-intake

## 目的

Gmail の受信メールを決定的に分類し、請求書 PDF の取り込みとクラウド通知を行う。本文・添付本体・URL は DB、ログ、Discord に保存しない。

## 完了条件

- SPEC-MAIL-INTAKE-001: 同じ message_id は二度処理しない。
- SPEC-MAIL-INTAKE-002: 本文と添付本体を DB・ログ・Discord に出さない。
- SPEC-MAIL-INTAKE-003: Gmail 認証情報または webhook 未設定は disabled/skip として成功と区別する。
- SPEC-MAIL-INTAKE-004: 発行元・日付・金額が揃う PDF だけ receipts 化し既存投入・突合を通す。
- SPEC-MAIL-INTAKE-005: ルールは先頭一致で、未一致は ignore とする。
- SPEC-MAIL-INTAKE-006: invoice/cloud_notice は結果にかかわらず message_id ごとに一通通知する。

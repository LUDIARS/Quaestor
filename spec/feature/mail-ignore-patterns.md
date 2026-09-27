# 非LLMの同系統ignoreメール判定

## 目的と責務
mail-intakeの支援処理として `@ludiars/blackbox` のCondition評価・ルールストア・判断台帳を再利用する。
`decide()` のLLM fallbackは使わず、決定的なメール用採掘アダプタを追加する。共通ライブラリの
会計向けLLM学習経路は変更しない。受信箱からの削除・既読化・Gmailラベル変更は行わない。

- SPEC-MAIL-IGNORE-001: 通常の請求書・クラウド・CI分類が優先。通常分類がignoreの場合だけ
  送信元の完全一致、数字/URL正規化した件名、本文構造のAND条件を評価する。
  HTMLは開閉タグ列、plain textは段落長の帯・行数・リンク有無。条件は版付きSHA-256特徴量。
- SPEC-MAIL-IGNORE-002: 異なるmessage_idで5通以上の共通特徴があるとseed/autoルールを生成。
  判定の母集団は通常ルールでignoreになったメールであり、内容が不要であるとの人間の正解ラベルではない。
  添付あり、本文不足・上限超過、請求/支払/注文/認証等の保護語を含む入力はルール適用・学習の対象外。
  同一IDは一度のみ加点。撤回済みの同条件ルールは復活させない。
- SPEC-MAIL-IGNORE-003: 本文・HTML・URL・送信元・件名の原文は新しい特徴テーブルやblackbox台帳に保存しない。
  個人情報を含む既存mail_messages履歴は従来の扱い。ルール適用時は履歴outcomeにルールIDを記録。
- SPEC-MAIL-IGNORE-004: `POST /v1/mail/ignore-patterns/bootstrap {limit:1..200}` は処理済みignoreの
  本文特徴だけをバックエンド内で補完。添付本体、会計取込、通知、元の処理日時の書換えを行わない。
  再実行は記録済みIDを除外。現在の通常ルールでpositiveになったメールは追加しない。
- SPEC-MAIL-IGNORE-005: `GET /v1/mail/ignore-patterns` で根拠件数とルール状態を確認できる。
  `POST /v1/mail/ignore-patterns/:id/retire` で撤回できる。管理APIは既存の直接loopback制限を維持。
  履歴UIは適用メールに「共通パターンで除外（LLM不使用）」を表示する。

ルールデータの正本: `src/mail/ignore-policy.ts`（版・閾値・保護語）、DBの
`mail_ignore_evidence`（ID単位の根拠）、`blackbox_rules` の `mail.bulk-ignore` domain（生成条件）。
生メールはコミットしない。仕様からの固定サンプルを運用メールと偽ってseedしない。

検証: `tests/mail-ignore-engine.test.ts`（特徴のAND条件、独立件数、保護対象、永続化、撤回、補完の冪等性）。
実データのルール整備はマージ反映後にbootstrapを実行し、件数だけ確認する。

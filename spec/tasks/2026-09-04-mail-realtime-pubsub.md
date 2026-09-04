---
task: mail-realtime-pubsub
project: Quaestor
kind: 実装
created: 2026-09-04
memory_links:
  - spec/feature/mail-realtime.md
  - spec/feature/mail-intake.md
---
# Gmail のリアルタイム受信 (Pub/Sub) と CI 失敗 / Dependabot 検知後の起動 (Part C)

## 目的

メールの取り込みは定時 sweep (3 回/日) だけで、CI が落ちたことも Dependabot alert が来たことも
最大 8 時間気付けなかった。設計書 `spec/plan/2026-09-04-mail-realtime-pubsub-ci-dependabot.md`
Part C の Quaestor 側を実装し、Pub/Sub StreamingPull で 〜1 秒の受信経路を足したうえで、
`ci_failure` / `dependabot` を決定的コードで分類し、Concordia の委託 (`ci-failure-fix` /
`deps-sweep-repo`) を起動する。

realtime は「速い経路」であって「正しさの根拠」ではないため、既存の定時 sweep は残し、
subscriber 停止中や `historyId` 失効時の取りこぼしを埋める保険とする。分類も起動判断も
LLM を使わず、メール本文は DB・ログ・Discord・委託プロンプトのいずれにも載せない。

## 完了条件

- [x] C-1: `quaestor.config.json` の `mailIntake.realtime` (enabled / topicName / subscriptionName /
      labelIds / repoAllowlist) と、暗号化ストアの `QUAESTOR_PUBSUB_SA_JSON` を設定として通す。
      `spec/setup/config-and-secrets.md` に追記する。
- [x] C-2: `mail_watch_state` / `mail_action_throttle` を新設し、`mail_messages.kind` の CHECK 制約に
      `ci_failure` / `dependabot` を足す migration (v21) を書く。SQLite は CHECK を ALTER できないので
      新テーブル → `INSERT ... SELECT` → `DROP` → `RENAME` で作り替え、既存行を保持する。
      `MailKind` と `MessageQuerySchema` の `z.enum` も併せて広げる。
- [x] C-3: `MailIntakeService` の per-message ループを `processMessages` へ切り出し (挙動は不変)、
      `syncFromHistory` を追加する。基準点は DB の `history_id`、expired は全件 sweep へフォールバックして
      貼り直し (`fell_back: true`)、in-process の mutex 1 本で直列化する。
- [x] C-4: `ci_failure` / `dependabot` の分類ルールを invoice ルールより前に置き、
      `src/mail/github-notice.ts` でヘッダと件名から repo / reason / workflow / head sha / run URL を取る
      (本文は読まない。run URL は github.com 配下のみ許可)。
- [x] C-5: `src/services/mail-actions.ts` で throttle 判定 → 失敗ログ取得 → delegation invoke。
      `ci_failure` は head_sha 単位で 1 回 + (repo, workflow) 6 時間 / 1 日 3 回、`dependabot` は
      同一リポ 24 時間に 1 回。throttle でスキップしたときも Discord へ通知し `skipped: throttled` を明記する。
      同時実行数は Concordia の `admin.delegation_max_concurrency` に任せる。
- [x] C-6: `POST /v1/mail/watch/renew` / `POST /v1/mail/watch/stop` / `GET /v1/mail/watch` /
      `POST /v1/mail/sync` を追加する。loopback ガードは既存のまま。設定・鍵が欠けていれば
      `{ disabled: true, reason }` を 200 で返す。
- [x] C-7: `/health` に `mail_realtime` (enabled / connected / watch_expires_at / last_notified_at / stale)
      を足す。`ok` 自体は落とさない。
- [x] C-8: `realtime.enabled` と鍵が揃っているときだけ起動時に subscriber を張り、終了シグナルで止める。
      通知は `syncFromHistory` のトリガとしてのみ使う (通知内の historyId を信じない)。
- [x] C-9: `spec/feature/mail-realtime.md` (SPEC-MAIL-REALTIME-001〜010) を新設し、
      `spec/domains/mail-intake.domain.json` に新ファイルを追加する (新ドメインは作らない)。
- [x] `npm run lint` (tsc --noEmit) 0 エラー、`npx vitest run` 全緑 (88 files / 724 tests)。
      追加テスト: migration の CHECK 拡張と既存行保持、syncFromHistory の初回 initialize / expired
      フォールバック / 並行呼び出しの直列化、mail-actions の head_sha 単位 1 回と throttle 時の通知、
      github-notice のパース、Excubitor catalog からの endpoint 解決。

## スコープ (編集可ディレクトリ)

`src/mail/`、`src/services/mail-*.ts`、`src/services/excubitor-catalog.ts`、
`src/db/mail-*.ts`、`src/db/schema.ts`、`src/api/mail-intake.ts`、`src/app.ts`、`src/server.ts`、
`src/services/app-config.ts`、`src/services/notification-service.ts`、`quaestor.config.json`、
`spec/`、`tests/`。OCR / 突合 / 請求書共有には触らない。

## 前提未確定

GitHub 通知メールの実物 (`List-ID` / `X-GitHub-Reason` の書式、件名の実文字列) は未確認のまま実装した。
取れなければ起動を見送り `skipped` を通知へ明記する形にしてあるので、誤起動ではなく取りこぼしに倒れる。
実物を 1 通確認したら `mailIntake.rules` の `subjectAny` と `github-notice.ts` の正規表現を確定させる。
GCP 側 (topic 作成 / gmail-api-push への Publisher 付与 / pull subscription / 鍵投入) は neco の作業で未了。

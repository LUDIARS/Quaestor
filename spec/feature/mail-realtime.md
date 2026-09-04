# mail-realtime

## 目的

Gmail の受信を Pub/Sub の StreamingPull で 〜1 秒で受け取り、 CI 失敗 (`ci_failure`) と
Dependabot (`dependabot`) の通知メールを検知して、 Concordia の委託 (`ci-failure-fix` /
`deps-sweep-repo`) を起動する。 分類も起動判断も決定的コードで行い、 メール本文は
DB・ログ・Discord・委託プロンプトのいずれにも載せない。

リアルタイム経路は「速い経路」であって「正しさの根拠」ではない。 既存の定時 sweep
(`quaestor-mail-sweep`、 3 回/日) はそのまま残し、 subscriber 停止中や `historyId` 失効時の
取りこぼしを埋める保険とする。

対象ファイル: `src/services/mail-watch-runner.ts`、 `src/services/mail-actions.ts`、
`src/services/mail-intake-service.ts`、 `src/services/excubitor-catalog.ts`、
`src/mail/github-notice.ts`、 `src/db/mail-watch-state-repo.ts`、
`src/db/mail-action-throttle-repo.ts`、 `src/db/schema.ts`、 `src/api/mail-intake.ts`、
`src/app.ts`。
テスト: `tests/mail-sync-history.test.ts`、 `tests/mail-actions.test.ts`、
`tests/mail-watch-runner.test.ts`、 `tests/github-notice.test.ts`、
`tests/mail-messages-kind-migration.test.ts`、 `tests/excubitor-catalog.test.ts`、
`tests/mail-classify.test.ts`。

## 完了条件

- SPEC-MAIL-REALTIME-001: Pub/Sub 通知は `syncFromHistory` のトリガとしてのみ使い、 通知内の
  `historyId` を基準にしない。 差分の基準は `mail_watch_state.history_id` とする
  (Pub/Sub に順序保証が無いため)。
- SPEC-MAIL-REALTIME-002: `history` が expired のときは全件 `sweep` にフォールバックし、
  `currentHistoryId()` で `history_id` を貼り直す。 応答に `fell_back: true` を含める。
- SPEC-MAIL-REALTIME-003: realtime と定時 sweep が同時に走っても同じ `message_id` を 2 回
  処理しない。 `syncFromHistory` は in-process の mutex 1 本で直列化し、 `history_id` の
  巻き戻りを防ぐ。差分内のメッセージ取得が一件でも失敗した場合は基準点を進めず、次回に
  再試行する。
- SPEC-MAIL-REALTIME-004: `ci_failure` の委託起動は同一 `head_sha` に対して 1 回だけ行い、
  `(repo, workflow)` の 6 時間間隔と 1 日 3 回の上限も満たしたときにのみ起動する。
  同時実行数の上限は Concordia の `admin.delegation_max_concurrency` に委ね、 Quaestor では
  数え直さない。
- SPEC-MAIL-REALTIME-005: 鍵・設定が欠けているときは `{ disabled: true, reason }` を 200 で
  返し、 成功と区別する (`mailIntake.realtime.enabled=false` / `QUAESTOR_PUBSUB_SA_JSON`
  未投入 / topic・subscription 未設定)。
- SPEC-MAIL-REALTIME-006: `/health` と `GET /v1/mail/watch` に subscriber の接続状態、
  watch 失効日、 最終受信時刻を出す。 watch 期限まで 2 日未満、 または最終受信から 24 時間
  以上経過していれば `stale` とする。 `ok` 自体は落とさない。
- SPEC-MAIL-REALTIME-007: throttle で起動を見送ったときも Discord には必ず通知し、
  `skipped: throttled` を明記する。
- SPEC-MAIL-REALTIME-008: `dependabot` の `deps-sweep-repo` 起動は同一リポジトリ 24 時間に
  1 回まで。 同じ日 (JST) に起動済みならスキップし、 日次 sweep との重複を実用上抑える。
- SPEC-MAIL-REALTIME-009: `ci_failure` の起動対象は `mailIntake.realtime.repoAllowlist` に
  一致するリポジトリのみとし、 外部リポジトリの通知で委託を出さない。GitHub 通知は Gmail
  の認証結果で github.com の DKIM または DMARC が成功したものだけを起動材料とし、repo は
  妥当な `owner/name` に限定して委託先パスが `ARS_ROOT` 外へ出ないことを検証する。
- SPEC-MAIL-REALTIME-010: `mail_messages.kind` の CHECK 制約は `ci_failure` / `dependabot` を
  含む。 既存 DB は table 作り替えで広げ、 既存行を保持する (SQLite は CHECK を ALTER
  できないため)。

## 構成

| 層 | 実体 | 役割 |
|---|---|---|
| 購読 | `@ludiars/mail-watch` の `MailWatchSubscriber` | Pub/Sub StreamingPull。 公開エンドポイント不要 |
| 常駐 | `src/services/mail-watch-runner.ts` | 購読の起動・停止、 `users.watch` の登録・解除、 状態の外出し |
| 差分 | `MailIntakeService.syncFromHistory` | `users.history.list` の差分を既存の per-message 処理へ流す |
| 分類 | `src/mail/classify.ts` + `mailIntake.rules` | 先頭一致。 GitHub ルールは請求書ルールより前 |
| 抽出 | `src/mail/github-notice.ts` | List-ID / X-GitHub-Reason / 件名から repo・workflow・head sha を取る |
| 起動 | `src/services/mail-actions.ts` | throttle 判定 → 失敗ログ取得 → Concordia delegation invoke |
| 記録 | `mail_watch_state` / `mail_action_throttle` | 差分の基準点と起動の debounce |

## API

| Method/Path | 内容 |
|---|---|
| `POST /v1/mail/watch/renew` | `users.watch` を張り直し `{ expires_at, history_id }` を返す |
| `POST /v1/mail/watch/stop` | `users.stop`。 購読も止める |
| `GET  /v1/mail/watch` | 接続状態・基準点・失効日・受信数・再接続数・最終エラー |
| `POST /v1/mail/sync` | `syncFromHistory()` の手動実行 (デバッグ用) |

`/v1/mail` 配下の直接 loopback ガードは既存のまま維持する。

## 設定とシークレット

- `quaestor.config.json` の `mailIntake.realtime` (`enabled` / `topicName` /
  `subscriptionName` / `labelIds` / `repoAllowlist`)。
- 暗号化ストアの `QUAESTOR_PUBSUB_SA_JSON` (Pub/Sub 購読用サービスアカウント鍵 JSON)。
  Gmail 読み取りの `QUAESTOR_GMAIL_*` (OAuth refresh token) とは別の資格情報。
- Concordia の endpoint はポートを焼き付けず Excubitor catalog から解決する
  (`src/services/excubitor-catalog.ts`)。

## 前提未確定

GitHub 通知メールの実物 (`List-ID` / `X-GitHub-Reason` の実際の書式、 件名の実文字列) は
本実装時点で未確認。 現行は次の形を前提にし、 いずれも取れなければ起動を見送って
`skipped` を通知へ明記する (誤起動より取りこぼしを選ぶ)。

- `List-ID: <owner>/<name> <name.owner.github.com>` (表示名が無い形にも対応)
- 件名 `[<owner>/<name>] Run failed: <workflow> - <branch> (<head sha>)`
- 件名 `[<owner>/<name>] Dependabot alert: ...`

実物を 1 通確認したら `mailIntake.rules` の `subjectAny` と `github-notice.ts` の正規表現を
確定させる。 Gmail のカテゴリ振り分け (Promotions) に入っていると `labelIds: ["INBOX"]` の
watch でも拾えない点も併せて確認する。

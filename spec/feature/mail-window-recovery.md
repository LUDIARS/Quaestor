# Gmail 停止期間の限定取り込み

対象は 2026-10-03 10:00:00 JST 以上、2026-11-25 10:48:48 JST 未満。通常巡回と同じ設定済み検索条件・Gmail アカウントを使う。復旧専用の検索では設定条件を括弧でまとめ、下限直前の秒と上限秒で絞る。各 ID の `internalDate` をミリ秒で判定する。全ページの検査と DB 照合が済んだ場合だけ本文の読み取りへ進む。

検索式の秒指定とグループ化は Gmail の仕様に従う。Google 側でこの対象期間に返る件数は本番の事前集計で確認する。[Gmail API の検索](https://developers.google.com/workspace/gmail/api/guides/filtering)・[Gmail 検索演算子](https://support.google.com/mail/answer/7190)

## HQ からの操作経路と認証境界

リポジトリ設定の Gmail 設定画面は `https://qs.ai-run-do.com` にある。Qs の Web プロキシは元の Host を保持する。設定画面の Cookie は発行ホスト専用で、HTTPS では Secure・HttpOnly・SameSite=Lax、パスは `/v1/gmail-auth`。ブラウザはこの Cookie を loopback に送らない。公開 origin 設定時、loopback の `/setup` は 403。Web の Gmail 連携カードと設定画面には復旧操作がない。

復旧ルータは開始と状態照会の両方で、backend への直接の loopback 接続、既存の有効な Gmail 設定セッション、対応する CSRF 値を要求する。公開 Host からは利用できない。Ex Viewer は上流に `X-Forwarded-Prefix` を付けるため、こちらも 403。Cc の既存 Qs メール連携に対象期間の復旧操作はない。確認したルータとクライアントには、本人のブラウザから集計・取り込み・状態確認まで通せる既存の経路は見つかっていない。本番の認証済みブラウザとランタイム設定は未検証。

### 次段の運用案（設計比較のみ）

| 案 | サーバー側に必要なもの | 本人の操作 |
| --- | --- | --- |
| Cc の既存の認証済み管理画面に、今回の期間だけの操作を置く | Cc の企業セッションには Cernere でプロジェクトと owner/admin を照合する既存判定がある。本人の有効なセッションと Qs の操作権限が確認できる入口に限定し、既存の同一 origin・CSRF 対策を適用する。Qs への認証済みの引き渡しと、稼働中の Qs 内の復旧処理につなぐ部分が必要。 | 通常の管理ログインで集計を開始し、対象期間・件数を読んで取り込みを選び、同じ画面で結果件数を確認する。 |
| Ex の正規管理機構に、今回限りの管理操作を登録する | Ex の公開管理 Host には許可リストと Cloudflare Access JWT の検証がある。サービス制御の契約は起動・停止・再起動等で、Qs の復旧操作は含まない。本人の既存管理権限を必須にした限定操作と、稼働中の Qs への認証済みの引き渡しが必要。ローカル側は接続元だけでは本人を識別できない。 | Ex の認証済み管理経路にログインし、集計の結果を確認して取り込みを指示し、同じ要求の状態を確認する。 |

確認したコードでは、本人のセッションとロールを照合する処理を流用できる Cc 案が最小候補。どちらも固定期間の三操作だけを扱い、既存の Gmail 認証・共有クォータを持つ Qs プロセスで実行する。Qs 向けの既存の操作権限と認証済み配送を実証できることが採用条件。どちらの接続も未実装で、本番で運用できることは未確認。公開 Gmail 設定画面や Viewer の公開範囲はこの案に含めない。

根拠は Qs の `src/api/gmail-oauth.ts`、`src/api/mail-recovery.ts`、`web/vite.runtime.config.ts`、Cc の `src/web-sso/gate.ts` と `src/scheduler/agent-job-sources/quaestor-mail-http.ts`、Ex の `src/security/local-browser-guard.ts`、`src/index.ts` の service control、`src/viewer/headers.ts`。

## 隔離テストで確認する API 契約

以下はテスト用に生成したセッションによる backend の契約。実運用は、上記の正規管理経路が確認できた段階で行う。

1. `POST /v1/gmail-auth/recovery` に次の JSON を送る。`request_id` は呼び出し元で生成した UUID。同一要求の再送には同じ UUID を使う。

   ```json
   {
     "mode": "dry_run",
     "request_id": "<UUID>",
     "startUtc": "2026-10-03T01:00:00.000Z",
     "endUtc": "2026-11-25T01:48:48.000Z"
   }
   ```

2. `GET /v1/gmail-auth/recovery/<request_id>` で同じ要求の状態を取得する。HTTP 202 は受付。事前集計が `phase=finished`、`exhausted=true`、`unknownDate=0` であることを確認する。
3. 同じ POST に `mode=import_missing`、新しい `request_id`、直前の集計の `dry_run_id`、同じ期間を指定する。取り込み時にも全件の受信日時と既存行を再確認する。請求書は既存ローカル PDF 解析・保存経路、クラウド通知はローカルの分類記録を使う。既知の除外ルールは読み取りのみ。CI・依存関係、外部解析が必要なメール、取り込める PDF がない請求書は `deferred` に残し、行を確保しない。
4. 新しい UUID で事前集計を再実行する。`imported` は新規に取り込んだメール行数。`deferred`、`existingError`、`processing`、`unresolved`、`raced` は取り込み成功に加算しない。既存のエラー・処理中の行を修復するには別途調査が必要。

## 排他・中断・復帰

同一 backend プロセス内で復旧ジョブは一つ。別の復旧要求との競合は 409、同じ要求は元の状態を返す。通常巡回・backfill・履歴同期は同時に進められる。Gmail 読み取りは同じ認証済み source の要求単位のキュー、予算、provider cooldown を共有する。復旧のローカル予算待ちはキューの外で行う。Gmail 自体の利用制限は双方に適用され、復旧では `partial` と `retryAt` を記録する。再試行可能時刻まで新規復旧要求は 429。

通常巡回の検索条件、pending、ページ位置、履歴基準点の更新は通常処理だけが行う。復旧はページ間の重複 ID を一度だけ照合する。本文・添付の取得前、再試行時および取得後に Qs のメール行を再照会する。通常処理が確保済みなら `raced` として読み飛ばし、最後の書き込み競合は既存の原子的な claim に任せる。異なるメールが同じ PDF を同時に保存した場合は SHA-256 の一意制約で書類を一つに保つ。

復旧用の `mail_recovery_jobs` は要求 ID、固定期間、モード、段階、集計だけを保存する。メール ID・ページトークンはこの表に保存しない。中断後は元の要求 ID で記録を確認する。再起動時は実行中だった記録を `interrupted` とし、新しい UUID で事前集計から再開する。Gmail の資格情報が変わった場合も事前集計をやり直す。確保済みのメール行は既存の原子的な claim により二重処理を防ぐ。

## 後段の反映と検証

ホスト側の承認は取得済み。root が差分と認証済みの運用経路を検証して後段を判断する。後段で反映する場合は Cc の testing claim を先に取得し、審査済みの版を Qs 本体へ反映する。Ex の所有 catalog の `quaestor`、本体 cwd、稼働版と health を照合する。監視起動で対象版が読み込まれたかを先に確認し、必要な場合だけ Ex で本体 backend を再起動する。health と正規の管理入口の動作を確認して testing claim を解放する。実データはその管理入口で事前集計、件数確認、未処理分の取り込み、再集計の順に進める。

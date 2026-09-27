# Gmail OAuth Web 認証

ユーザーが GCP の既存 OAuth クライアントで Gmail 読み取りを許可し、Google → Qs backend →
暗号化ストアの経路で refresh token を保存する。AI・チャット・ツールへ秘密値を貼る手順は持たない。

- SPEC-GMAIL-OAUTH-WEB-001: 設定画面の Gmail 連携カードから backend のローカル認証ページを開く。
  認証ページは Qs ホスト PC の `127.0.0.1` だけで利用できる。Viewer / Tunnel / LAN は対象外。
  backend の設定ポートから URL を生成する。GCP web client は表示された callback URI を登録する。
- SPEC-GMAIL-OAUTH-WEB-002: OAuth client JSON (`web` / `installed`) または ID・secret をブラウザで直接投入する。
  Google の endpoint は固定し、アップロード JSON の endpoint は利用しない。値は応答へ戻さない。
  scope は `gmail.readonly`、offline consent を要求。service account / ADC JSON は取り込まない。
- SPEC-GMAIL-OAUTH-WEB-003: CSRF token と Origin 検証、HttpOnly / SameSite=Lax cookie、単回 state、
  PKCE S256、10分の期限で callback を開始ブラウザに結び付ける。同時保留は最大32セッション。
  プロセス再起動時は認可を最初からやり直す。外部転送、iframe、cross-site form は拒否する。
- SPEC-GMAIL-OAUTH-WEB-004: token exchange は backend のみ。refresh token と readonly scope を検証して
  client情報と一括暗号化保存する。キャンセル・権限不足・再送・交換失敗では既存保存値を保持する。
  ストア復号失敗は更新を拒否し、空ストアで既存値を消さない。ファイル交換は暗号文の atomic rename。
- SPEC-GMAIL-OAUTH-WEB-005: HTML / JSON / ログに client secret、code、token、Googleの生エラーを出さない。
  cookieとCSRF以外の秘密は HTML に埋めない。callback 成功時は query の無い setup URL へ303で戻す。
  no-store / no-referrer / CSP を付与し、UI は外部アセット・解析スクリプトを読み込まない。
- SPEC-GMAIL-OAUTH-WEB-006: 成功後は既存 GmailSource が新しい資格情報を遅延参照するため再起動不要。
  未設定時の sweep は従来の disabled 応答を維持する。保存状態は有効性の保証と区別して表示する。
  Pub/Sub や定期ジョブの設定・実メール取込・GCP アプリ作成は本変更では実行しない。

認証は同じ Google アカウントの再認証を想定する。別アカウントへのデータ移行は対象外。
Web 認証による保存値は起動時の Gmail 環境変数より優先する。

実装: `src/services/gmail-oauth.ts`, `src/services/gmail-oauth-page.ts`, `src/api/gmail-oauth.ts`,
`web/src/components/GmailConnectionCard.tsx`。起動配線は `src/server.ts`, `src/app.ts`。

Google 公式仕様: https://developers.google.com/identity/protocols/oauth2/web-server

## 操作

1. Qs 実行 PC の Web UI → 設定 → Gmail と連携。
2. GCP の既存 OAuth クライアント JSON を選択するか、ID・secret を画面に直接入力。
3. Web クライアントの場合、画面に表示された redirect URI を GCP に登録。
4. Google の画面で対象アカウントを選び、読み取りを許可。
5. Qs の「保存しました」を確認。設定カードの「保存状態を確認」で表示更新。

承認者自身がブラウザで実施する。AI に token や OAuth client JSON を渡さない。
認証画面や callback ではプロキシのアクセスログも使わず、ローカル backend に直接接続する。

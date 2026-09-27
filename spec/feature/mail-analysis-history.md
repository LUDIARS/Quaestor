# メール解析履歴

- SPEC-MAIL-HISTORY-001: 「取込 → メール解析履歴」および `/#mail-history` から永続化済みの
  mail_messagesを読む。対象外も含め、件名・差出人・分類・処理結果・受信日時・処理日時・エラーを表示。
  本文や認証情報は取得しない。件名等はReactの通常テキストとして描画しHTMLとして解釈しない。
- SPEC-MAIL-HISTORY-002: 分類絞り込み、受信日時降順・メールID降順で50件ずつのページ送り。
  履歴更新は先頭へ戻る。空・読込中・取得失敗を区別する。
- SPEC-MAIL-HISTORY-003: `GET /v1/mail-history` は履歴の読み取り専用。閲覧でGmail取得・分類・
  PDF解析・通知・履歴更新を行わない。既存のmessage_id重複防止と処理履歴は保持する。
- SPEC-MAIL-HISTORY-004: Cloudflare Accessで保護された設定済みHTTPS origin（gmailOAuthOrigin）
  のHostから閲覧可能。necoによる2026-09-28の公開ドメインでのメール情報閲覧承認に基づく。
  Accessはホスト全体を保護し、backendは直接公開しない。Host判定自体は認証の代替ではない。
  Viteはこの経路のHostを保持。別Origin/cross-site/Viewerは拒否。応答はno-store/no-referrer。
  直接loopback閲覧も維持。既存 `/v1/mail` の書込みAPIの制限を緩和しない。

実装: src/api/mail-history.ts、src/db/mail-messages-repo.ts、web/src/pages/MailHistory.tsx。
検証: tests/mail-history.test.ts。実ブラウザの画面・Cloudflareログイン後の動作は別途確認する。

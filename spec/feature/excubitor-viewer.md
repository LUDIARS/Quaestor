# Excubitor Viewerへの掲載

## 要件

2026-09-10、利用者がCc/Pfで既存画面を確認した後、Quaestorを含む残りサービスの掲載を依頼した。
既存のQuaestor Webを表示する。別の要約画面を作る依頼ではない。

## 配備契約

- Qs-VIEWER-01: 所有catalogのquaestor-webにviewer.enabled=true、entry_path=/を設定する。
- Qs-VIEWER-02: 入口はEx DMZの /viewer/apps/quaestor-web/。中継先portはcatalog正本からExが解決する。
- Qs-VIEWER-03: Webの既存 /v1 と /health 中継を使う。APIサービスquaestorを別のメニュー項目に追加しない。
- Qs-VIEWER-04: WebフロントにViewerホスト名を埋め込まない。ExのURL変換と既存hashナビゲーションを使う。
- Qs-VIEWER-05: `isDirectLoopbackRequest` で保護されたAPIは、Viewerが付与する
  `X-Forwarded-Prefix` を検出して拒否する。Viewerからの最終hopがloopbackでも直接接続として扱わない。

統合入口は適切なCloudflare Access設定で保護されるという利用者の前提を継承する。
同じ信頼範囲の内部サービスとしての掲載であり、インターネットへの無認証公開を意味しない。
公開認可を削除する、Cloudflare設定を変更する、Ex管理APIを公開する変更は行わない。

## 受け入れ・反映

審査ではopt-inが残っていること、entry_pathが既存Web入口と一致することを確認する。
要件を満たせない指摘があれば理由を示す。opt-in削除で差分を空にした状態は要件達成ではない。
動作確認は別途利用者の許可後、本体フォルダとExcubitor経由で行う。
Web未起動なら掲載だけでは表示できないため、実際の画面・JS/CSS・API・hash遷移に加え、
direct-loopback専用APIがViewer経由では403になることを確認する。
単体・統合・起動テストはこの修正では未実施。

# メール進捗の受付 ID 保存

参照: actio:47daf22c-5f9f-4775-9e41-c84ebefeade6
仕様: SPEC-MAIL-CRAWLER-006

- [x] Cc chat と Lictor send-file の現行ソースで二重 message 応答を確認
- [x] 実装前に C-1 契約と独立した判定述語を作成
- [x] 既存 Zod を再利用し、正の安全整数 ID の検証を独立モジュールへ配置
- [x] pending の排他的作成と成功時のみの receipt/checkpoint 更新
- [x] Augur plan の回帰テスト提案に沿い合成 fixture テストを追加
- [ ] Revisor による回帰テストとマージ完了
- [ ] 契約ランタイム依存の取得・挿入と観測証跡の収集

## 契約

C-1 acceptedProgressMessageId(receipt): 正しい二重 message 応答の正の安全整数 ID のみを返し、それ以外は null とする

## 検証計画と制約

正常応答、欠落・不正 ID、誤った入れ子、受付失敗、HTTP 400/502、JSON 破損、
通信失敗、pending 中の再試行、既存 receipt/checkpoint の保全を合成 fixture で検証する。
外部通知・メール処理・サービス操作を行わない。Actio の明示制約によりテスト未実行。
Augur inject apply は成功したが、@ludiars/log-weaver の取得が npm.pkg.github.com への
接続 EACCES で失敗した。未解決依存を製品コードへ残さないため挿入だけ remove し、
契約定義・述語・挿入設定は保持した。観測証跡は未充足として報告する。

## 再利用・障害記録

既存 relay の保存順と CLI の停止処理を維持。既存 Zod を利用し新規検証ライブラリは不要。
Cc/Lictor の応答仕様は確認のみで変更しない。受付と Discord 配送の証明を区別する。
原因は旧 relay の message.id 参照であり、実際は message.message.id に受付 ID がある。
main の problem log は指定 worktree 外への編集禁止のため未作成。

静的確認: git diff --check と変更 TypeScript 4 ファイルの構文診断はエラーなし。
型全体の検証・回帰テスト実行・契約の実行観測は未実施。

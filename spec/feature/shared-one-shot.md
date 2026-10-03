# 単発 CLI の共有起動境界

Claude 共通ヘルパー、レシート OCR、メール分類の Codex 起動は Lapilli の @ludiars/one-shot を使用する。lib/lapilli の submodule コミットを固定し、file: 依存として読み込む。Node 22.12 以上が必要。初回は submodule update --init -- lib/lapilli の後に npm ci を実行する。

役割名と未指定モデルは共有設定で具体的モデルへ解決し、明示 ID は維持する。OCR のログには解決後モデルを残す。API キー等の起動環境の整理と Windows 実行ファイルの解決は共有層が所有し、shell を経由しない。SDK 経由の OCR は変更しない。

Quaestor はプロンプト、stdin 入力、解析、タイムアウトと子プロセス終了を所有する。OCR の非同期完了通知・書き戻し、メール分類の read-only / ephemeral / ツール無効化 / 入出力上限 / 成功完了必須の契約を維持する。共有層はリトライや権限追加を行わない。

検証: mail-codex-exec.test.ts は共有起動関数を置換し、メール本文の stdin 限定、失敗・ツール呼び出し拒否、秘密の除去、モデル上書きを検証する。実 CLI・サービスを起動しない。変更の復旧は消費側 PR の revert と submodule 参照の復元で行う。

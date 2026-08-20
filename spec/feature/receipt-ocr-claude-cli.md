# レシート OCR を走らせる claude CLI の起動条件

## SPEC-RECEIPT-OCR-CLI-001 — OCR のモデルを固定する

レシート OCR は `claude -p` を spawn して実行する (API キーを持たず CLI 自身の auth を使う)。
このとき **`--model` を明示する**。

モデルを指定しないと CLI 既定のモデルに乗るため、 同じモデルの利用上限を対話セッション側で
使い切っていると OCR も巻き込まれ、 画像を見る前に exit 1 で終わる。 呼び出し側から見ると
「読み取り失敗」 と区別が付かない。

利用上限・認証・モデル指定の失敗は、 レシート内容の読み取り前に終了し得るため、
OCR 結果だけでは原因を区別できない。

- 設定: `quaestor.config.json` の `ocrClaudeCode.model` (既定 `sonnet`)
- env override: `QUAESTOR_OCR_CLAUDE_MODEL`
- 明示的に `null` を書いた時だけ `--model` を付けず CLI 既定へ委ねる
  (キー未指定は既定モデルであって、 CLI 既定ではない)
- モデル名は英数字で始まり、英数字・`.`・`_`・`-` のみを 128 文字まで許可する。
  不正な設定値は既定の `sonnet` に戻す。

起動したモデルは receipt ごとの claude-code ログ先頭へ `model: <名前>` として記録する。
上限・認証・モデル指定ミスをログだけで切り分けられるようにするため。

# Runtime Version Reporting

## SPEC-RUNTIME-VERSION-001 — 配備バージョンの一貫した表示

`EXCUBITOR_SERVICE_VERSION` が設定されている場合、Quaestor は英数字で始まり、英数字・
`.`・`_`・`+`・`-` だけからなる 128 文字以下の値を `/health` の `version` と起動ログの
構造化フィールドへ出力する。それ以外または未設定時の値は常に `"unavailable"` とする。

Web UI はビルド時環境変数を参照せず、`/health` から取得した `version` をヘッダーへ表示する。
取得できない場合は `"unavailable"` を表示する。バージョンは配備の運用メタデータであり、
資格情報や構成値をここへ設定してはならない。

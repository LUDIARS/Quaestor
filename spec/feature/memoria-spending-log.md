# Memoria支出ログ連携

## 目的

Quaestorのカード・銀行・各種Pay取引と、投入済レシートをMemoriaのローカル専用ログへ渡す。
金額と位置はセンシティブ情報のため、通常ログやAI処理へは流さない。

## API

`GET /v1/integrations/memoria/spending-logs?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`

- 直接loopback接続からのみ利用可能。
- 最大期間は366日。
- `Cache-Control: no-store`。
- 取引と突合済レシートは1つの`transaction:*`レコードにまとめ、日次合計で二重計上しない。
- 未突合レシートは、ユーザが「投入」したものだけを`receipt:*`レコードとして出力する。
- 振替、入金、未投入レシートは支出ログから除外する。

全レコードに次の属性を付ける。

- `privacy_class: sensitive.financial_location`
- `retention_scope: local_only`
- `llm_relay_scope: diary_only`
- 日付、場所、Google Maps参照URL、GPS相当座標
- 購入品と分類（`food` / `clothing` / `toy` / `undetermined`）
- 経費算入予定（按分ルール未確定なら`null`）
- 決済種別と表示名
- 場所別金額、通貨別の日次合計

Google Placesへの外部送信は行わない。GPSがあれば座標、なければ店名からMaps検索URLだけを生成し、
`google_place_id`は将来の明示的な外部照会に備えて`null`とする。

LLMへ渡すことが許可される経路はMemoriaの日記生成だけとする。通常のAI Hub、Discord、
Corpus、Multi Hubや他のLLM処理へはリレーしない。

# calc から引き継ぐべき学び

`E:\calc` (確定申告 2025 用に作った personal toolset) の解析メモ。 Quaestor は同じ問題を「専用ツール」として作り直す位置づけなので、 calc が泥臭く解いていた部分を一級市民として設計に組み込む。

## 1. CSV import の罠

- **エンコーディング**: 日本のクレカ会社 CSV は Shift-JIS が普通。 `iconv-lite` 必須
- **金額表記揺れ**: カンマ / 全角スペース / マイナス / アポストロフィ混在 → 正規化関数を 1 箇所に
- **日付形式 4 種**: `YYYY年M月D日` / `YYYY/M/D` / `M/D` (年なし) / `M月D日` (年なし) — calc/parse-bank-pdf.js parseDate 参照
- **ブランド判別**: 行 1 のカード番号プレフィクス (`4980-09` → SMBC-3 等) や、 確定/未確定列の存在で判別。 ヘッダ単独では足りない
- **複数 csv 同月束ね**: `202501.csv`, `202501 (1).csv`, `202501 (2).csv` のように 1 月分が複数ファイルに分割されているケースが普通

## 2. 按分率 + 科目コードのルール体系

calc の正本は `按分率一覧.md` + `convert-all-with-rate.js` の `RATE_RULES`。
- **pattern → rate (0..1) + 科目コード** の順序付きリスト
- 具体的なものから先にマッチさせる (Netflix が "PAYPAL" 系より先、 等)
- 既定は `rate: 0, code: 0` (家計支出 = 事業主貸 124 への振替)
- Quaestor では DB 化 + UI 編集可能にし、 新規取引先が出たら手入力 → ルールに追加するフロー

科目コード体系 (仕訳帳構造.md より):
- `1` 売上、 `10-28` 経費、 `101+` 資産・負債
- 特に `10` 水道光熱費、 `11` 旅費交通費、 `12` 通信費、 `14` 接待交際費、 `17` 消耗品費、 `23` 地代家賃、 `25` 新聞図書費、 `26` ソフトウエア購入費、 `28` 会議費
- `101` 現金、 `102` 当座預金、 `124` 事業主貸、 `172` 事業主借

これを `spec/account-codes.md` に切り出して Quaestor の標準科目テーブルとして同梱する (ユーザがカスタム編集可)。

## 3. Amazon 履歴照合 — shipment grouping が肝

calc/match_amazon3.js のロジック:
1. Amazon が出す `Retail.OrderHistory.X.csv` を読む (Your Orders zip 展開後)
2. `(orderId, shipDate)` で grouping → これが「カードに 1 回乗る charge」 = shipment 単位
3. クレカ明細から Amazon 系 merchant を抽出 (`AMAZON|ＡＭＡＺＯＮ|Ａｍａｚｏｎ` regex)
4. shipment.totalOwed と クレカ amount をマッチ。 shipment 内の subtotal+tax で部分決済も試行
5. 不一致は `amazon_unmatched.json` に吐いて手動レビュー

ここは **明細単位 (item level) ではなく shipment 単位**でしかマッチしないのがポイント。 Quaestor でもこの粒度を採用。

## 4. 銀行 PDF — pdfjs より pdf-parse でフラット化

calc/parse-bank-pdf.js は SMBC 専用。
- `pdf-parse` で全文テキスト化
- 日付プレフィクス行を抽出 → 同行の引出/預入/残高を位置で切る
- 表罫線復元はやらず、 文字列パターンマッチで済ませている

実利的: 銀行ごとに行レイアウトが微妙に違うので、 brand-specific parser を plugin で持つ。 PDF 表抽出ライブラリは罫線無 PDF (multi-column) で逆に壊れがち。

UFJ は web archive (.webarchive) 経由で取得していた形跡。 PDF 化されていない場合の fallback として **HTML パース** ルートも残す価値あり。

## 5. Excel 書き戻し vs DB-first

calc は最終出力を `2025.xlsx` 直接編集 (会計ソフトに貼り付ける用)。 Quaestor は SQLite を真実のソースにし、 Excel/CSV は **export** に降格させる。 `仕訳帳` シート互換の export 機能は 1.0 で実装。

### 仕訳帳列構造 (Excel export 用、 仕訳帳構造.md より転記)

| 列 | 内容 |
|---|---|
| B | 日付 (Excel シリアル) |
| C | 仕訳番号 |
| D | 借方科目コード |
| E | 借方勘定科目 |
| F | 借方金額 |
| G | 貸方科目コード |
| H | 貸方勘定科目 |
| I | 貸方金額 |
| J | 摘要 |
| K | 支払 (計算用) |
| L | 按分率 |

仕訳パターン:
- 経費 (按分あり): `借方 経費科目(rate後金額) / 貸方 当座預金 102 (rate後金額)` 摘要=店名
- 家計 (按分外): `借方 事業主貸 124 (家計分) / 貸方 当座預金 102 (家計分)` 摘要=クレカ引き落とし調整
- 現金経費: `借方 経費科目 / 貸方 現金 101`

## 6. レシート × クレカ照合 — calc には未実装

calc にはレシート OCR のフローが無い (手で xlsx に入力していた)。 Quaestor の最大の追加価値はここ:
- AR スキャナでレシートを取り込み
- 取込時に self-contained record を作る (仕訳に出す前段階)
- 同日 ± 3 日 + 金額 + 店名類似度で credit-card transaction の候補を出す
- ユーザ承認 → reconciliation テーブルにリンク

## 7. その他、 calc 由来の細部

- `_check_*.js` `_dump_headers.js` 等の analytical 一発スクリプト群が大量にある — 開発中の sniff/debug が必須仕事だったことの証拠。 Quaestor でも CLI subcommand として `quaestor sniff <file>` を用意したい
- `2025_費用集計v2.xlsx` から `v8.xlsx` まで version が伸びる — 集計ロジックを何度も再走させた記録。 これは Quaestor では DB クエリ + view で 1 発化できる
- `_kaigi_*` `_kaigi_detail2.js` 等で会議費の按分が複雑化していた — 接待交際費との切り分けは pattern では難しいので、 ユーザ手動 tag に倒す
- `バンタン入金レポート.md` `vantan.md` のように 取引先固有の入金パターン (源泉徴収あり) も別建てメモがある。 Quaestor では「源泉付き売上」 entry type を別扱い

## 結論: Quaestor の MVP に最低限必要なもの

1. SJIS 対応 CSV import (UFJ + SMBC 1 系) — calc/convert-all-with-rate.js 移植
2. 按分率ルール DB + マッチエンジン
3. 科目コード固定セット (calc 仕訳帳構造.md 準拠)
4. Amazon Order History CSV import (shipment grouping)
5. SMBC 銀行 PDF import (calc/parse-bank-pdf.js 移植)
6. レシート OCR → receipt テーブル (新規、 calc に無い)
7. receipt × transaction reconcile (新規)
8. 仕訳帳 Excel export (calc 互換シート構造)

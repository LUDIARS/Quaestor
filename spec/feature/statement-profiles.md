# 明細プロファイル (Statement Profiles) — クレカ外部登録

クレカ等の明細 CSV を **列マッピングのデータ登録** だけで取り込めるようにする仕組み。
カードブランドをコードにハードコードせず、 ユーザが任意の会社の CSV を登録できる。

## 背景

UFJ / SMBC はカード番号→口座判定・FX 列など固有ロジックがあるため bespoke importer
(`importers/ufj-csv.ts` / `smbc-csv.ts`) を維持する。 それ以外の会社カードは、
列番号と文字コードを登録するだけの **汎用 profile importer** で対応する。

## データモデル (`statement_profiles`, schema user_version=5)

| 列 | 意味 |
|---|---|
| `name` / `brand` (unique) | 表示名 / import 時の brand slug |
| `source` | credit-card / bank / amazon / manual |
| `encoding` | auto / shift_jis / utf-8 |
| `header_skip` | 先頭読み飛ばし行数 |
| `col_date` / `col_payee` / `col_amount` / `col_memo?` | 0 始まり列番号 |
| `amount_sign` | out (出金) / in (入金) / signed (符号で判定) |
| `filter_col?` / `filter_value?` | 指定列がこの値の行のみ取込 (例 UFJ "確定") |
| `date_year_hint?` | M/D 形式 CSV の補完年 |
| `account_default?` | 既定 account ラベル |
| `detect_keywords?` | JSON 配列。 auto-detect 用 (本文に全キーワードを含めば一致) |
| `enabled` | 有効フラグ |

## 取込フロー (`api/imports.ts`)

1. brand 明示 → built-in importer → 無ければ profile (`findByBrand`)
2. brand 未指定 (auto-detect) → built-in `detect` → 無ければ `detectProfile` (keywords)
3. profile は `importers/profile-csv.ts` の `parseWithProfile` で
   `csv-utils` (decode/parseCsv) + `text` (normalizeDate/parseAmount) を再利用して解析。
   source_id は `brand + account/date/amount/payee/memo` の安定ハッシュ (再 import で dedupe)。

## API `/v1/statement-profiles`

CRUD (GET list/`:id` / POST / PUT `:id` / DELETE `:id`)。 brand 重複は 409。

## 制約 (MVP)

- 区切りはカンマ固定 (`parseCsv` 準拠)。 TSV 等は将来対応。
- PDF 明細は対象外 (SMBC 銀行 PDF は別 importer)。
- 複雑な口座判定が要るカードは bespoke importer を足す。

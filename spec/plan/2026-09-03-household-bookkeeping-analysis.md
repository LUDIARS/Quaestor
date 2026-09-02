# 家計簿 × 業務仕訳の両立・家計分析・按分シート — 設計書

作成: 2026-09-03 / 対象: Quaestor (Qs) / 状態: 実装済 (同 PR)。既存の Excel 簿記ブックの構造解析に基づく

## 0. 依頼 (neco)

1. 家計簿と業務の仕分けを両立させる仕組みとして、Excel 簿記の仕組みを移植する。
2. クレカ使用額とレシート等を紐づけ、どの場所でトータルいくら消費しているか等の
   家計分析ページを作る。週 / 月 / 3 ヶ月 / 6 ヶ月 / 1 年で解析する。
3. 按分シートを用意し、過去データから (1) の仕分けを自動生成するツールにする。

## 1. 現状と「Excel 簿記」の仕組み

参照したブックは「エクセル簿記 (Excel B)」テンプレートに既存の
スクリプト群で仕訳を流し込んだもの。シートの依存関係は次の 1 本道。

```
仕訳帳 (B:日付 C:№ D/E/F:借方 G/H/I:貸方 J:摘要 K:支払 L:按分率, N:=MONTH(B))
   │  E/H = VLOOKUP(コード, 勘定科目)   F = ROUNDDOWN(K*L)  (按分は仕訳帳側で完結)
   ▼
精算表  科目コードごとに SUMIF(仕訳帳!D, code, F) / SUMIF(仕訳帳!G, code, I)
        → 残高試算表 (借方合計・貸方合計) → 損益計算書列 / 貸借対照表列 (科目種別で振分)
        → 期首 (④ の期首) + 増減 = 期末
   ▼
決算書① (PL: 売上・経費科目別・所得)   ② (月別売上 = SUMIFS by MONTH)   ④ (BS 期首/期末)
元帳ⅰ (科目を選ぶと仕訳帳から相手科目・借方・貸方・残高を展開)
ⅱ (勘定科目 × 集計月 × 摘要 のピボット)
③ (減価償却) — 今回対象外
```

Quaestor には既に `journal.ts` (取引 → 仕訳行の一時生成) と `excel-export.ts`
(仕訳帳シートのみ書き出し) がある。ただし仕訳は **永続化されず** 、精算表以降の
集計層は存在しない。家計側は「事業主貸 124 に落ちた残り」としてしか見えず、
家計簿としての費目 (食費 / 外食 / 旅行 …) は `2025_家計分析.xlsx` を手作りしていた。

## 2. 方針

- **仕訳帳を正本テーブルにする** (`journal_entries`)。取引からの自動生成行と、
  売上入金 / 源泉税 / 現金引出 / 家賃 / 利息などの手動行を同じ帳簿に置く。
- **家計と業務を 1 本の仕訳で両立** させる。按分率 r の取引は
  `経費科目 (A·r) / 当座預金` と `事業主貸 124 (A·(1-r)) / 当座預金` に展開する
  (Excel 簿記と同じ)。事業主貸行に **家計費目 (household_category)** を付けることで、
  同じ帳簿が青色申告用の仕訳帳であり家計簿でもある状態にする。
- 精算表 / 元帳 / 月別集計 / PL・BS は **仕訳帳からの純関数** として実装し、
  Excel 側の SUMIF / VLOOKUP と同じ結果になる契約をテストで固定する。
- 家計分析は **支出イベント** (取引 + 突合済レシート、または未突合の投入済レシート)
  を単位にし、場所 (payee 正規化 + レシート GPS) と費目で集計する。
- 按分シートは **決定的な履歴集計** で作る。LLM を使う既存の
  `apportionment-advisor` (blackbox) とは別物で、過去の仕訳帳 xlsx / 既存帳簿から
  「この店は過去何回、どの率・科目で処理したか」を集め、そのままルール化する。

## 3. データモデル (migration user_version 15 → 16、すべて `CREATE IF NOT EXISTS`)

### 3.1 `journal_entries` — 仕訳帳

| 列 | 型 | 意味 |
|---|---|---|
| id | INTEGER PK | |
| fiscal_year | INTEGER | 会計年度 (暦年) |
| entry_date | TEXT | ISO yyyy-mm-dd (Excel B) |
| no | INTEGER | 仕訳番号 (C)。年度内連番、再生成時に振り直す |
| debit_code / debit_amount | INTEGER | D / F |
| credit_code / credit_amount | INTEGER | G / I |
| description | TEXT | 摘要 (J) |
| payment | INTEGER | 支払 (K) 元取引金額 |
| rate | REAL | 按分率 (L) 0..1 |
| origin | TEXT | `transaction` (取引から自動生成) / `manual` (手入力) / `imported` (xlsx 取込) |
| source_tx_id | TEXT NULL | 元 transactions.id |
| receipt_id | TEXT NULL | 突合レシート (現金経費など) |
| household_category_id | INTEGER NULL | 事業主貸行に付く家計費目 |
| locked | INTEGER | 1 なら再生成で上書きしない (ユーザが手で直した行) |
| created_at / updated_at | INTEGER | |

インデックス: (fiscal_year, entry_date, no)、(source_tx_id)、(debit_code)、(credit_code)。
UNIQUE (source_tx_id, leg) を持たせ、leg = `expense` / `household` / `income` で
1 取引から出る行を識別する (再生成の冪等性)。

### 3.2 `household_categories` — 家計費目

`2025_家計分析.xlsx` の「生活費の内訳」を初期 seed にする
(食費 / 食費(外食) / 食費(スーパー) / 日用品 / 旅行・レジャー / 交通 / 医療 /
教育 / 通信 / 光熱 / 住居 / 保険 / 税金 / ATM 現金引出 / 娯楽 / 衣服 / その他)。
`parent_id` で 2 階層。ユーザ編集可。

### 3.3 `household_rules` — 家計費目ルール

`apportionment_rules` と同じ形 (pattern regex / priority / enabled) で
payee → household_category を引く。既定は「その他」。

### 3.4 `apportionment_observations` — 按分シートの素材

| 列 | 意味 |
|---|---|
| fiscal_year | 観測元の年度。年度単位の再取込で他年度の観測を保持するために使う |
| payee_norm | normalizePayee 済み店名 |
| payee_sample | 表示用の生表記 |
| rate / code | 観測した按分率・科目 |
| occurrences | その組合せの出現回数 |
| total_amount | 金額合計 |
| first_seen / last_seen | 日付 |
| source | `journal-xlsx` (calc の仕訳帳取込) / `ledger` (Quaestor 帳簿) |

UNIQUE (fiscal_year, payee_norm, rate, code, source)。集計テーブルなので削除・再構築自由。

## 4. サービス層 (1 ファイル 1 責務)

### 4.1 簿記 (`src/services/bookkeeping/`)

| ファイル | 責務 |
|---|---|
| `journal-ledger.ts` | 取引 → 仕訳行の永続化。年度単位の `rebuild(fiscalYear)` は `origin=transaction` かつ `locked=0` の行だけ入れ替え、`manual` / `imported` / `locked` は保持。既存 `journal.ts` の `buildJournal` を再利用し、事業主貸行には `household_rules` で費目を付ける |
| `manual-entries.ts` | 特殊仕訳テンプレ (売上入金 102/1、源泉税 117/1 = 売上×10.21%、現金引出 101/102、利息 102/172、家賃 23/102、住民税 124/102) の生成と手入力 CRUD |
| `trial-balance.ts` | 精算表: 科目ごと借方合計 / 貸方合計 → 残高 → kind で PL 列 / BS 列へ振分。期首残高は `financial_statements` の `opening` section (label = 科目コード、amount = 残高) から取り、期末 = 期首 + 増減 |
| `bookkeeping-reports.ts` | 年度の帳簿集計の façade。仕訳帳を読んで上記の純関数に渡す。期首残高の読み書きもここ |
| `general-ledger.ts` | 総勘定元帳: 科目を指定して相手科目・借方・貸方・残高の推移 |
| `monthly-summary.ts` | ⅱ 相当: 科目 × 月 × 摘要のピボット、② 相当の月別売上 |
| `financial-report.ts` | 決算書①/④ 相当: PL (売上・科目別経費・所得)、BS (期首/期末) を trial-balance から組む |
| `bookkeeping-workbook.ts` | Excel 簿記互換ブックの書き出し (仕訳帳 / 精算表 / 元帳 / 月別集計 / 決算書)。仕訳帳はエクセル簿記と同じ 7 行目見出し・8 行目データ。既存 `excel-export.ts` から切り出した `writeJournalSheet` を呼ぶ |
| `journal-xlsx-import.ts` | エクセル簿記の `仕訳帳` シートを読む。見出し行は B=「日付」かつ D に「コード」を含む行を自動検出 (エクセル簿記は 7 行目、Quaestor export は 6 行目)。数式セルは結果値、L が `-` の行は rate=1。`はじめに` シートの AA/AB/AC から勘定科目表も読む。圧縮後 8 MiB・展開後 64 MiB・20,000 行を上限とする |
| `journal-import.ts` | パース結果を `origin=imported` で年度単位に置換取込し、未知の科目を `account_codes` に足し、`apportionment_observations` (source=journal-xlsx) を更新する |

### 4.2 家計 (`src/services/household/`)

| ファイル | 責務 |
|---|---|
| `household-classifier.ts` | payee → household_category (rules → fallback その他)。事業主貸行と支出イベントの両方で使う |
| `spend-events.ts` | 支出イベントの組立: 取引 (is_transfer=0, amount_out>0) と突合レシートを 1 イベントに束ね、未突合の投入済レシートを現金支出として足す。二重計上回避は `behavior-analysis.ts` と同じ規則 (再利用) |
| `analysis-windows.ts` | `week` (月曜起点 ISO 週) / `month` / `quarter` (3 ヶ月) / `half` (6 ヶ月) / `year` の期間計算と、直前同長期間の算出。純関数 |
| `household-analysis.ts` | 期間内イベントを 費目別 / 場所別 (payee_norm) / 地点別 (レシート GPS を 100 m グリッドで丸め) / 決済手段別 / 日別推移 に集計し、前期間との差分を返す。家計分と経費分 (按分率) を分けて持つ |

### 4.3 按分シート (`src/services/apportionment-sheet/`)

| ファイル | 責務 |
|---|---|
| `observation-collector.ts` | Quaestor 帳簿 (`journal_entries` の origin=transaction/manual) と取込済 xlsx から `apportionment_observations` を再構築 |
| `sheet-builder.ts` | 店ごとに 1 行の按分シートを組む: 観測分布 (率・科目ごとの回数・金額)、現行ルールの解決結果、提案 (最多の率・科目)、ずれの有無、年間影響額 |
| `rule-synthesizer.ts` | シートの提案行から `apportionment_rules` (pattern = 正規化店名の完全一致 `^…$`、priority 300、note `sheet:<日付>`) を生成する。既存ルールでカバー済みの店はスキップ、現行と食い違う店は `override` 指定時のみ既存より小さい priority で上書き。生成は dry-run と apply の 2 段。家計費目 (`household_rules`) は観測に費目が無いため自動生成せず、同画面のルール編集で人が足す |

## 5. HTTP API (`src/api/`)

| ファイル | ルート | 内容 |
|---|---|---|
| `bookkeeping.ts` | `POST /v1/bookkeeping/:year/rebuild` | 取引から仕訳帳を再生成 (manual/imported/locked は保持) |
| | `GET /v1/bookkeeping/:year/journal?month=&code=` | 仕訳帳一覧 |
| | `POST /v1/bookkeeping/:year/journal` / `PATCH /journal/:id` / `DELETE /journal/:id` | 手動仕訳 (テンプレ指定可)、修正は locked=1 |
| | `GET /v1/bookkeeping/:year/trial-balance` | 精算表 |
| | `GET /v1/bookkeeping/:year/ledger/:code` | 総勘定元帳 |
| | `GET /v1/bookkeeping/:year/monthly` | 科目 × 月 × 摘要 |
| | `GET /v1/bookkeeping/:year/report` | PL / BS |
| | `GET /v1/bookkeeping/:year/workbook.xlsx` | Excel 簿記互換ブック |
| | `GET/PUT /v1/bookkeeping/:year/opening` | 期首残高 |
| | `POST /v1/bookkeeping/import-journal` | エクセル簿記の仕訳帳 xlsx 取込 (`content_b64`、年度はブックの日付から) |
| `household.ts` | `GET /v1/household/analysis?window=week|month|quarter|half|year&anchor=YYYY-MM-DD` | 家計分析 |
| | `GET/POST/PATCH/DELETE /v1/household/categories` | 家計費目 CRUD |
| | `GET/POST/PATCH/DELETE /v1/household/rules` | 家計費目ルール CRUD |
| `apportionment-sheet.ts` | `POST /v1/apportionment-sheet/collect` | 観測の再構築 |
| | `GET /v1/apportionment-sheet?year=` | シート取得 |
| | `POST /v1/apportionment-sheet/synthesize {dry_run}` | ルール生成 |

`/v1/exports/journal.xlsx` (既存) は維持する。

## 6. 画面 (`web/src/pages/`)

| ページ | タブ | 内容 |
|---|---|---|
| `Bookkeeping.tsx` | 簿記 | 年度セレクタ + サブタブ (仕訳帳 / 精算表 / 元帳 / 月別 / 決算書)。仕訳帳は行の修正・手動追加・再生成・xlsx 取込・ブック出力 |
| `HouseholdAnalysis.tsx` | 家計分析 | 期間切替 (週/月/3ヶ月/6ヶ月/1年) と基準日。費目別 (前期間比)、場所別ランキング、地点別 (GPS)、日別推移バー、レシート紐づき率 |
| `ApportionmentSheet.tsx` | 按分シート | 店ごとの観測分布 / 現行 / 提案。チェックして「ルール生成」(dry-run → apply)。家計費目も同画面 |

`App.tsx` の PAGES に 3 タブを追加する。
入力 UI は Foundation の `.foundation-form` に揃える。

## 7. 期間解析の定義

| window | 範囲 | 比較対象 |
|---|---|---|
| week | anchor を含む月曜〜日曜 | 直前の 7 日 |
| month | anchor の月 | 前月 |
| quarter | anchor 月を末尾とする 3 ヶ月 | その前 3 ヶ月 |
| half | 同 6 ヶ月 | その前 6 ヶ月 |
| year | 同 12 ヶ月 | その前 12 ヶ月 |

クレカ明細は 1 ヶ月遅れで入るため、レスポンスに `coverage` (データのある最終月) を
含め、画面で「最新月は未取込の可能性」を出す。

## 8. 再利用の採否

- `journal.ts#buildJournal` — 採用。仕訳展開ロジックはここ 1 箇所に置き、永続化層はその出力を書く。
- `excel-export.ts#buildJournalWorkbook` — 採用 (仕訳帳シート生成を分離して呼ぶ形に小改修)。
- `behavior-analysis.ts` — 支出イベントの二重計上回避規則を採用。ただし「店ランキング」に
  特化しているので集計本体は別ファイル (`spend-events.ts`)。
- `apportionment-advisor.ts` (blackbox / LLM) — 併存。按分シートは決定的で LLM を呼ばない。
- `financial-statements-repo.ts` — `opening` section を期首残高の置き場として再利用。
  既存の `computeFromTransactions` は残し、`report` は trial-balance 側を正とする。

## 9. テスト計画

| テスト | 内容 |
|---|---|
| `journal-ledger.test.ts` | 再生成の冪等性、locked/manual 保持、家計費目付与 |
| `trial-balance.test.ts` | 固定仕訳セットから Excel の SUMIF と同値になること、PL/BS 振分、期首+増減=期末 |
| `general-ledger.test.ts` | 残高推移、相手科目 |
| `monthly-summary.test.ts` | 科目×月×摘要、月別売上 |
| `financial-report.test.ts` | PL 所得 = 売上 − 経費、BS 貸借一致 |
| `bookkeeping-workbook.test.ts` | シート構成と仕訳帳列位置 (B..L, row 7 起点) |
| `journal-xlsx-import.test.ts` | exceljs で作った仕訳帳ブックの往復 |
| `analysis-windows.test.ts` | 5 window の境界 (年跨ぎ・月末) |
| `household-analysis.test.ts` | 突合レシートの二重計上なし、費目/場所/地点集計、前期間比 |
| `apportionment-sheet.test.ts` | 観測集計 → 提案 → ルール生成 (dry-run と apply)、既存ルール重複回避 |
| `bookkeeping-api.test.ts` / `household-api.test.ts` | ルート疎通と入力検証 |

## 10. 対象外 (明示)

- 減価償却 (③) と消費税計算。
- 期首残高の自動推定 (前年 BS の取込は `financial_statements` の manual 入力に委ねる)。
- Excel ブックへの数式書き戻し (値のみ出力。Excel 側の SUMIF は不要になる)。

## 11. Anatomia ドメイン

新規ディレクトリはいずれも既存ドメインの `pathPattern` 内
(`src/services/**` → accounting-services、`src/api/**` → http-api、
`src/db/**` → persistence、`web/src/**` → web-frontend、`tests/**` → test-support)。
ドメイン JSON の追加は不要。

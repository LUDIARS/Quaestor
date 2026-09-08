# 家計簿 × 業務仕訳・家計分析・按分シート (household-bookkeeping)

設計書: `spec/plan/2026-09-03-household-bookkeeping-analysis.md`。 ここは実装が `@implements` で指す条項の正本。

## SPEC-HOUSEHOLD-BOOKKEEPING-001 — 仕訳帳を正本テーブルにする

- `journal_entries` がエクセル簿記「仕訳帳」の B..L 列と同じ意味を持つ (日付 / № / 借方 / 貸方 / 摘要 / 支払 / 按分率)。
- `origin` は `transaction` (取引から自動生成) / `manual` (手入力) / `imported` (xlsx 取込)。
- 年度単位の `rebuild` は `origin=transaction` かつ `locked=0` の行だけを入れ替え、 それ以外は保持する (冪等)。
- 仕訳番号は年度内で (日付, id) 順に振り直す。

## SPEC-HOUSEHOLD-BOOKKEEPING-002 — 家計と業務を 1 本の仕訳で両立する

- 按分率 r の取引は `経費科目 (A·r) / 当座預金` と `事業主貸 124 (A·(1-r)) / 当座預金` に展開する。
- 事業主貸行 (`leg=household`) には家計費目 (`household_categories`) を付ける。 判定は `household_rules` → 既定「その他」。
- 家計費目とルールはユーザが編集でき、 seed は名前が無いものだけ足す。

## SPEC-HOUSEHOLD-BOOKKEEPING-003 — 精算表・元帳・月別集計・決算書は仕訳帳からの純関数

- 精算表: 借方合計 / 貸方合計 は Excel の SUMIF と同値。 損益科目は PL 列、 資産・負債は BS 列。 期首 + 増減 = 期末。
- 所得 = 収益 − 費用。 合計行は PL / BS ともに貸借一致する。
- 元帳: 資産・費用は 借方 − 貸方、 負債・資本・収益は 貸方 − 借方 で残高が動く。
- 月別: 科目 × 月 × 摘要、 月別売上は売上科目の貸方合計。

## SPEC-HOUSEHOLD-BOOKKEEPING-004 — エクセル簿記ブックの往復

- 取込: 「仕訳帳」シートの見出し行を B=「日付」かつ D に「コード」を含む行で自動検出し、 その次の行から読む。 数式セルは結果値。 L が `-` の行は rate=1。
- 「はじめに」シートの勘定科目表 (AA コード / AB 名 / AC 分類) から未知の科目を `account_codes` に足す。
- 取込は年度単位で置換し、 経費 / 家計行から `apportionment_observations` (source=journal-xlsx) を作る。
- 取込は圧縮後 8 MiB・展開後 64 MiB・仕訳 20,000 行を上限とし、展開前に ZIP の容量を検証する。
- 書き出し: 仕訳帳 / 精算表 / 元帳 / 月別集計 / 決算書 の 5 シート。 仕訳帳は 7 行目見出し・8 行目データ。

## SPEC-HOUSEHOLD-ANALYSIS-001 — 支出イベント

- 取引 (振替除外、 出金のみ) と突合済レシートを 1 イベントに束ね、 未突合の投入済レシートを現金イベントとして足す。 突合済レシートを二重計上しない。
- 各イベントは按分ルールで 事業分 (amount × rate) と 家計分 に割れる。

## SPEC-HOUSEHOLD-ANALYSIS-002 — 期間と集計

- window は `week` (月曜起点) / `month` / `quarter` / `half` / `year`。 比較対象は直前の同長期間。
- 費目別 (家計分を費目へ、 事業分は擬似費目「事業経費」)、 場所別 (正規化店名)、 地点別 (レシート GPS を約 100 m 格子)、 決済手段別、 日別推移 を返す。 費目別の合計 = 支出合計。
- データのある最終月 (coverage) を返し、 画面は未取込の可能性を示す。

## SPEC-HOUSEHOLD-ANALYSIS-003 — 家計支出の評価

- 分析 API の `evaluation` は家計分のみを対象にする。各期間の家計支出を暦日数で割った日額の前期比で、+10% 以上は増加、−10% 以下は減少、それ以外は横ばいとする。10% は表示用の比較基準であり、予算・収入に基づく健全性判定ではない。
- サーバーの今日（注入可能）時点で対象期間が終了していない、今期または前期に支出イベントがない、前期の家計支出がゼロ、両期間に含まれる月が coverage に欠ける場合は評価保留とし、理由をすべて返す。増減率は null、影響費目は空にする。
- coverage は支出記録のある月を示すだけで取込完了の証明ではない。画面は取込済みデータの参考評価であることと、明細の取込漏れを判別できないことを明示する。
- 費目ごとの日額差分の絶対値が大きい順に最大 5 件を根拠として表示する。同値は費目 ID 順。事業経費（擬似費目 0）は除外し、前期のみの費目も含める。
- 評価は純関数で、元データ・按分ルールを変更せず外部サービスを呼ばない。既存 API の集計値は維持する。
- 実装は `src/services/household/household-evaluation.ts`、契約は `src/shared/household-evaluation.ts`、画面は `web/src/components/HouseholdEvaluationCard.tsx`。

## SPEC-HOUSEHOLD-ANALYSIS-004 — インカム・アウトカム、貯蓄傾向と節制提案

- インカムは取引の `is_transfer=0 AND amount_in>0` を日付範囲内で集計する。仕訳帳と重ねて集計しない。売上・返金・借入の識別や手入力仕訳のみの収入取込は現状の入力契約では行わず、画面に限界を表示する。
- アウトカムは既存の支出イベント合計。家計・事業の内訳を併記する。収支差額は入金−家計支出−事業支出、貯蓄率の目安は差額÷入金（入金ゼロは null）。実際の口座残高の増減とは区別する。
- 今期・前期の貯蓄率差をポイント表示し、正なら上昇、負なら低下、ゼロなら横ばい。期間未終了、いずれかの期間に入金または支出記録なし、比較範囲に支出記録のない月があれば傾向を保留して理由を返す。
- 両期間の月別入金・支出・差額・貯蓄率を返す。週などで月全体を含まない場合や当月・未来月は `is_partial` を表示する。
- 節制提案は既定費目名「食費(外食)」「食費(コンビニ)」「娯楽・サブスク」「旅行・レジャー」「衣服・美容」に限定する。医療・住居などを自動的に削減対象としない。カスタム費目は自動推測しない。
- 各候補に支出額・件数・具体的な見直し方法・10%削減時の試算（円未満切捨て）を付け、試算額降順、同額は費目ID順で最大5件返す。今期の実績に基づく仮定の試算であり、節約可能額の保証や残り期間への予測ではない。候補は今期実績のみで決まるため前期比の日額差分は持たない。
- 実装は `src/services/household/household-cash-flow.ts`、`src/services/household/income-events.ts`、`src/services/household/saving-suggestions.ts`、契約は `src/shared/household-cash-flow.ts`、画面は `web/src/components/HouseholdCashFlowCard.tsx` と `web/src/components/HouseholdSavingSuggestions.tsx`。
- 検証ケースは `tests/household-evaluation.test.ts` と `tests/household-cash-flow.test.ts` に記載。

## SPEC-APPORTIONMENT-SHEET-001 — 観測は人が決めた行から作る

- `ledger` 観測は `origin=manual` と `origin=transaction かつ locked=1` の経費 / 家計行だけ。 未編集の自動生成行は入れない。
- 観測は (店, 率, 科目, source) ごとに回数と金額を持ち、 再構築で増えない。

## SPEC-APPORTIONMENT-SHEET-002 — シートとルール生成

- 店ごとに 観測分布 / 提案 (最多) / 現行ルール / 状態 (match, differs, proposal, unknown) / 当年支出 を出す。
- ルール生成は決定的で LLM を呼ばない。 pattern は正規化店名の完全一致、 priority 300、 note `sheet:<日付>`。 dry-run と apply の 2 段。 `differs` は override 指定時のみ既存より小さい priority で上書き。

# 水道光熱費スキャンと固定費 / 変動費 (cost-structure)

設計書: `spec/plan/2026-09-03-cost-structure.md`。

## SPEC-COST-STRUCTURE-001 — 分類ルール

- `cost_rules` は pattern (正規表現、 正規化店名に i フラグで当てる) → cost_type (fixed / variable) と utility (electric / gas / water / 無し)。 priority 昇順で最初に当たったものを採る。 未マッチは variable。
- API から登録する pattern は構文を検証し、同期処理を長時間占有し得る backreference と group repetition は拒否する。
- seed: AI / ソフトウェアの長期契約 (OpenAI / Anthropic / Claude / AWS / Notion / Adobe / Microsoft / Google Workspace / GitHub / JetBrains / Netflix / Amazon プライム / NHK)、 通信 (au / docomo / SoftBank / 光回線)、 家賃 / 保険 / 水道光熱費 は fixed。 水道光熱費は utility も持つ。

## SPEC-COST-STRUCTURE-002 — 支出の集め方と二重計上回避

- 家計分析と同じ支出イベント (取引 + 突合レシート + 未突合の投入済レシート) を使う。
- 取引が 1 件も無い月に限り、 取込済み仕訳 (origin=imported の経費 / 家計行) を支出として補う。 同じ月に取引があれば仕訳は使わない。

## SPEC-COST-STRUCTURE-003 — 固定費候補の自動判定

- 直近 N ヶ月 (既定 6) のうち 3 ヶ月以上に出現し、 月合計の変動係数 (標準偏差 ÷ 平均) が 0.25 以下の店を固定費候補にする。 既にルールがある店は除く。
- 候補の採用は正規化店名の完全一致ルール (priority 300、 note `suggest:<日付>`) を作る。同じ pattern の無効ルールがあれば重複作成せず、内容を更新して再有効化する。

## SPEC-COST-STRUCTURE-004 — 水道光熱費スキャンとビュー

- utility を持つルールに当たったイベントを 月 × 種別 (electric / gas / water) で合計し、 anchor 月を末尾とする 12 ヶ月の推移と、 前年同月との差を返す。
- 固定費 / 変動費ビューは window (week / month / quarter / half / year) の合計・店別 (件数、 金額、 事業分、 月次系列)・前期間比を返す。

## SPEC-COST-STRUCTURE-005 — 検針票由来の供給者ルール

- スキャンして `utility` (検針票・公共料金) と分類された書類を投入するとき、 その供給者を `cost_rules` に入力する
  (`src/services/cost-structure/utility-supplier-rules.ts`)。 統計から推測する固定費候補 (SPEC-COST-STRUCTURE-003)
  と違い、 紙に書かれた確定値なので priority 200 (seed の 10〜50 より後、 提案の 300 より前) で入れる。
- 種別 (electric / gas / water) は供給者名を先に見て、 決まらなければ使用量の単位で決める。 単位で決めるのは
  kWh (electric) だけにする (m3 / ㎥ は ガス と 水道 の両方で使われる)。 どちらでも決まらなければルールを作らず、
  レシートの投入だけ行う (要確認には残さない)。
- pattern は 供給者名 と レシートの payee の完全一致 (両方が同じなら 1 つ) で、 note は `utility-scan:<日付>`。
  既存ルールで既に utility が付く供給者ならルールを増やさない。 同じ pattern の無効ルールがあれば再有効化する。
- 投入されたレシートは支出イベント (SPEC-COST-STRUCTURE-002) として水道光熱費ビューに載る。
  投入の起点は `src/services/receipt-kind-destinations.ts` (spec/feature/scan-document-kinds.md SPEC-SCAN-KIND-005)。

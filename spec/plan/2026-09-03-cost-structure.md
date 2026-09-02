# 水道光熱費スキャンと固定費 / 変動費ビュー — 設計書

作成: 2026-09-03 / 対象: Quaestor (Qs) / 状態: 実装済 (同 PR)

## 0. 依頼 (neco)

「水道光熱費のスキャンと、各種経費のうち固定費と変動費を分けて表示するビューを作ろう。AI 代とかソフトウェアで長期契約しているものは固定費でいい。」

解釈: 「スキャン」は紙の検針票を撮る機能ではなく、 **取引・レシート・取込済み仕訳の中から 電気 / ガス / 水道 の支払いを自動検出して月次で見せる** こと。 固定費 / 変動費は **ルール + 定期性の自動判定** で分け、 AI・ソフトウェアの長期契約、 家賃、 保険、 通信、 水道光熱費を固定費の既定にする。

## 1. 方針

- 支出イベントは家計分析と同じ `spend-events.ts` (取引 + 突合レシート、 未突合の投入済レシート) を使う。 加えて **取引の無い月** だけ、 取込済み仕訳 (origin=imported、 経費 / 家計行) を支出として補う (2025.xlsx 由来の過去分を見せるため。 同じ月に取引があれば二重計上を避けて仕訳側は使わない)。
- 分類は `cost_rules` (pattern → cost_type / utility / label、 priority 順) → 未マッチは変動費。 ルールは seed + ユーザ編集 + 自動提案の取り込み。
- **定期性の自動判定**: 直近 6 ヶ月のうち 3 ヶ月以上に出現し、 月ごとの金額の変動係数が 25% 以内の店は「固定費の候補」として提案する (有効ルール未設定のものだけ)。 提案は 1 クリックでルール化 (正規化店名の完全一致。同じ pattern の無効ルールは更新して再有効化)。
- **水道光熱費スキャン**: `utility` が electric / gas / water のルールに当たったイベントを月 × 種別で集計し、 直近 12 ヶ月の推移、 前年同月比、 最新月の内訳を返す。 検出パターンは 電力 (東京電力 / TEPCO / でんき / 電気料金 / 電力)、 ガス (東京ガス / ニチガス / ガス料金)、 水道 (水道料金 / 水道局 / 上下水道) を seed にし、 ユーザが足せる。
- 既存の按分ルール (事業 / 家計) は別軸のまま。 ビューでは各店の事業分 (按分率) も併記する。

## 2. データモデル (v17 → v18)

`cost_rules`: id / pattern / cost_type (`fixed` | `variable`) / utility (`electric` | `gas` | `water` | NULL) / label / priority / enabled / note / created_at / updated_at。 seed は `src/db/cost-rules-seed.ts`。

## 3. サービス (`src/services/cost-structure/`)

| ファイル | 責務 |
|---|---|
| `cost-classifier.ts` | payee → {cost_type, utility, label, rule_id} (rules → 既定 variable) |
| `journal-spend-events.ts` | 取引の無い月を取込済み仕訳から補う支出イベント |
| `recurring-detector.ts` | 店 × 月の出現と金額から固定費候補を出す純関数 |
| `utility-scan.ts` | 水道光熱費の月 × 種別集計 (12 ヶ月推移、 前年同月比) |
| `cost-structure.ts` | window の固定費 / 変動費ビュー (合計、 店別、 月別推移、 事業分) と提案 |

## 4. API (`/v1/cost-structure`)

| ルート | 内容 |
|---|---|
| `GET /?window=&anchor=` | 固定費 / 変動費ビュー (家計分析と同じ window) |
| `GET /utilities?months=12&anchor=` | 水道光熱費スキャン |
| `GET /suggestions?months=6&anchor=` | 固定費候補 |
| `POST /suggestions/apply {payees[]}` | 候補をルール化 |
| `GET/POST/PATCH/DELETE /rules` | ルール CRUD |

## 5. 画面

`CostStructure.tsx` (家計・資産 セクション「固定費・変動費」): 上段に水道光熱費 (種別ごとの月次バーと最新月)、 中段に固定費 / 変動費の合計と店別 (月次ミニ推移)、 下段に固定費候補 (採用ボタン) とルール編集。

## 6. テスト

- `cost-structure.test.ts`: 分類 (seed で AI / ソフトウェア / 家賃が固定)、 定期性判定、 水道光熱費の月次集計、 取引の無い月だけ仕訳で補う、 API 疎通と提案の適用。

## 7. 対象外

検針票 OCR、 電力会社 API 連携、 使用量 (kWh / m³) の抽出。

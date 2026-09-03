---
task: scan-kind-downstream-wiring
project: Quaestor
kind: 実装
created: 2026-09-03
memory_links:
  - spec/feature/scan-document-kinds.md
---
# 書類種別ごとの投入先配線 (invoice / utility / statement) と種別別重複キーのゲート適用 (A-1)

## 目的

D1 (Revisor local PR #1258、 `feat/scan-doc-kind-sample-labels`) で書類種別 `doc_kind` の分類と
`kind_fields` の保存までは入ったが、 receipt / handwritten 以外の種別は投入先が未配線のため
投入ゲート (`src/services/receipt-commit.ts`) が `kind_not_auto_committed:<kind>` で要確認に残している。
設計書 §2.2 の表どおり、 種別ごとの投入先へ流し、 要確認に残るのを `other` と完備不足だけにする。

- invoice: `kind_fields` (issuer / due_date / invoice_no) をメール取込の `PdfExtraction` と同じ形に寄せ、
  `inbound_documents` 相当へ合流させて仕訳 (未払) へ繋ぐ。
- utility: supplier / period_from / period_to / usage を cost-structure の検出 (取引 / レシート / 取込仕訳) に
  「検針票由来」の確定値として合流させる。 `cost_rules` の utility 判定に供給者名を入力する。
- statement: `kind_fields.rows[]` を `smart-import.ts` と同じ rows として transactions へ流す
  (明細取込ページのスクショ入力の撤去は A-3 で別途)。
- 重複キー: `src/services/receipt-duplicate-keys.ts` の invoice (issuer + invoice_no) / utility (supplier + period)
  をゲートで使い、 種別ごとに二重投入を弾く。

## 完了条件

- `receipt-commit.ts` の分岐が種別ごとに投入先を呼び分け、 invoice / utility / statement で `ok: true` になる
  (`kind_not_auto_committed` が返るのは `other` のみ)。 分岐は API 側に散らさない。
- invoice / utility の重複は `invoiceDuplicateKey` / `utilityDuplicateKey` で `duplicate` を返す。
- utility の投入が cost-structure の水道光熱費ビュー (月 × 種別) に反映される。
- `spec/feature/scan-document-kinds.md` の SPEC-SCAN-KIND-001 の表 (投入先列) を実装に合わせて更新し、
  web の `DOC_KIND_INFO.destination` / `commitPolicy` (`src/shared/document-kinds.ts`) を同じ内容にする。
- テスト: 種別ごとの投入 happy path / 重複 / `other` の要確認残り。 `npx vitest run` 全緑、 root / web tsc 0 エラー。
- Anatomia `git diff | verify` 5 ゲート pass (spec の「実装の置き場所」表に新規ファイルを追記する)。

## スコープ (編集可ディレクトリ)

- `src/services/` (receipt-commit.ts、 receipt-duplicate-keys.ts、 cost-structure/、 smart-import.ts)
- `src/db/` (inbound-documents-repo.ts、 必要なら schema.ts の migration 追加)
- `src/shared/document-kinds.ts`、 `src/shared/receipt-kind-fields.ts`
- `src/api/receipts.ts`
- `spec/feature/scan-document-kinds.md`、 `spec/feature/cost-structure.md`
- `tests/`

## 実装結果 (2026-09-03)

- 投入先の対応表を `src/services/receipt-kind-destinations.ts` に置き、 `receipt-commit.ts` は
  「種別方針 → 完備 → 重複 → 配送 + 投入 (1 トランザクション)」 の判断だけを持つ。 API 側の分岐は増やしていない。
- invoice → `src/services/scan-invoice-intake.ts` (メール取込と同じ `PdfExtraction` / `inbound_documents`、 schema v20)。
- utility → `src/services/cost-structure/utility-supplier-rules.ts` (供給者を `cost_rules` へ、 水道光熱費ビューに反映)。
- statement → `src/services/scan-statement-intake.ts` + `src/services/statement-rows.ts`
  (source_id の算出を `smart-import.ts` と共通化)。 明細レシートは支出イベント・行動分析・
  Memoria 支出ログ / 自動突合から外す。
- 仕様は `spec/feature/scan-document-kinds.md` SPEC-SCAN-KIND-001 の表と SPEC-SCAN-KIND-005、
  `spec/feature/cost-structure.md` SPEC-COST-STRUCTURE-005、 `spec/feature/mail-intake.md` SPEC-MAIL-INTAKE-004 に反映。
- 残: 明細取込ページのスクショ入力の撤去 (A-3)、 web への配送結果表示 (受領書類 / 固定費 / 取込件数)。

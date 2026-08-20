# レシート自動投入と到着順に依存しない突合

## 目的

スキャンしたレシートを人手の押下なしに帳簿へ投入し、 クレジットカード明細との突合を
レシート・明細どちらが先に入っても成立させる。

OCR 抽出の精度が実運用で十分に出ているため、 「投入」 ボタンの押下は作業として残さない。
ただし投入の判断そのものは省かず、 従来と同じ完備判定・重複判定を通す。

## SPEC-RECEIPT-AUTO-INTAKE-001 — OCR 完了時の自動投入

OCR 結果が書き込まれた時点 (`PATCH /v1/receipts/:id/ocr` および OCR worker 経由) で、
`ocr_status` が `done` / `manual` のレシートを投入対象とする。

- 完備: `date` / `payee` / `total` が揃っていること
- 非重複: 投入済の中に同じ (日付-場所-金額) が無いこと (`payee` は正規化して比較)

いずれかを満たさないレシートは投入されず、 Scan 画面の手動投入・編集へ残る。
判定は `src/services/receipt-commit.ts` に集約し、 手動投入 (`POST /v1/receipts/:id/commit`)
と自動投入で分岐させない。

`buildApp({ autoIntake: false })` で自動投入と自動突合を止め、 従来の手動運用へ戻せる。

## SPEC-RECEIPT-AUTO-INTAKE-002 — 到着順に依存しない突合

レシートと明細の到着順は運用上どちらもあり得る。 片側のイベントで完結させず、
**未突合の投入済レシート** を母集団にした sweep (`src/services/auto-reconcile.ts`) を
両側の契機から呼ぶ。

| 契機 | 呼び出し | 成立するケース |
| --- | --- | --- |
| レシート投入 (自動・手動とも) | `ReceiptIntake.afterOcr` / `afterCommit` | 明細が先に入っていた |
| 取引取込 (`POST /v1/imports`, smart import) | `ReceiptIntake.afterTransactionsImported` | レシートが先に入っていた |
| 手動再実行 | `POST /v1/reconciliations/auto-match` | 閾値変更・取りこぼしの拾い直し |

スコアリングと閾値は従来どおり `src/services/reconcile.ts` / 0.85。 閾値未満は確定させず
Reconcile 画面の承認へ回す。

未投入のレシートは帳簿の対象外なので、 突合の母集団に含めない。

## 応答

- `PATCH /v1/receipts/:id/ocr` → `auto_commit: { committed, already } | { committed: false, reason }`、 `auto_reconciled`
- `POST /v1/receipts/:id/commit` → `auto_reconciled`
- `POST /v1/imports`, `POST /v1/imports/smart-*` → `auto_reconciled`

自動処理の失敗は OCR 結果の保存や取込自体を失敗させない (best-effort、 warn ログのみ)。

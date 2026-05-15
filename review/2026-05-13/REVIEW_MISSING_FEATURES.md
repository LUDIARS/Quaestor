# REVIEW_MISSING_FEATURES (2026-05-13)

評価: **C**

README ロードマップ v0.0〜v1.0 の主機能は全実装済 (README.md:44-53)。

- M1(C) AIFormat §5 への Quaestor 例外追記が未着手 (`README.md:37`, `DESIGN.md:143`)。 LUDIARS 全体ルール逸脱を declare しているのに本体同期無し。 最優先。
- M2(B) reconcile の split / partial match 未対応 (`src/services/reconcile.ts` + `src/db/schema.ts:107`)。 1:N / N:1 を schema が許容しない。
- M3(B) ledger 編集の audit log / undo 無し。 確定申告書類化を視野に入れると必須。
- M4(B) OCR 前の画像 redact / 確認 modal 無し (`src/services/ocr-client.ts:87`)。 病名・カード下 4 桁等の写り込みリスク。
- M5(情報) multi-account / 家族共有 (`DESIGN.md:175`) 未決のまま v1.0 達成。
- M6(情報) Cloud sync scaffold 無し。 「Cloud 行かない」 方針確定を README に。
- M7(情報) 銀行 OAuth 連携無し (V7=A)。 LUDIARS 整合上は Imperativus 委譲が筋。
- M8(情報) `payee LIKE %x%` 全件スキャン (`src/db/transactions-repo.ts:96`)。 数万件で遅延。 FTS5 で解決可能。

# REVIEW_IMPLEMENTATION (2026-05-13)

評価: **B**

- I1(B) `src/importers/smbc-bank-pdf.ts:129-148` で sync `Importer.parse` が empty 返却、 真処理は `parseSmbcBankPdf()` async (`:154`) を `src/api/imports.ts:65` で分岐。 `Importer.parse` を `T|Promise<T>` に。
- I2(B) `src/importers/amazon-order-history.ts:125` `s.total===0` で refund / partial cancel を silently drop。
- I3(B) `src/importers/smbc-bank-pdf.ts:67-115` memo 切り出しが「最初の数値手前」、 数字含む店名で列ズレ。 不明時は出金扱い。
- I4(C) `src/importers/ufj-csv.ts:58-60` fx 列が `row[10]/row[11]` ハードコード、 layout 変動で沈黙。 header sniff へ。
- I5(B) `src/services/reconcile.ts:129` `receipt_id != ?` 除外が 1:1 前提密結合。
- I6(A) `OcrWorker` (`src/services/ocr-worker.ts:70`) は in-flight skip + failed で対象外、 暴走防止可。
- I7(A) migration は `CREATE IF NOT EXISTS` + `ensureColumn` 冪等 (`src/db/schema.ts:160`)。
- I8(情報) `/health` (`src/app.ts:65`) が DB 触らず Tauri probe が真陽性化しない。

総評: 責務分離は清潔、 13 test ファイルで coverage 確保。 `Importer` interface が sync 縛りで脆い (I1/I4) が主課題。

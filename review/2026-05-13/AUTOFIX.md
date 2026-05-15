# AUTOFIX — Quaestor 自動修正候補 (2026-05-13)

ソースコード修正禁止 ルールに従い、 本セッションではいずれも適用しない。 列挙のみ。

`autofix_count = 0`

## 候補 (適用しない)

1. **V2 関連**: `src/server.ts:36` の OCR worker 自動起動条件に `process.env.QUAESTOR_OCR_AUTO === "1"` を AND 条件で追加。 既定は手動 trigger に倒す。
2. **V3 関連**: `src/api/imports.ts:18` の `PostBodySchema.content_b64` に `.max(67_108_864)` (約 50MB base64 = 36.5MB binary) を追加。
3. **D2 関連**: `src-tauri/tauri.conf.json:25` の `csp` を `default-src 'self'; connect-src 'self' http://127.0.0.1:17400 https://api.anthropic.com; img-src 'self' data: blob:; media-src 'self' blob:` 等で明示。
4. **I8 関連**: `src/app.ts:65-70` の `/health` で `deps.db.prepare("SELECT 1").get()` を実行し失敗時 500。 Tauri probe の真陽性化。
5. **Q3 関連**: `src/services/claude-code-ocr.ts:65` の log open を size check + rotate 付きに置換 (1MB 超で .1 にローテート)。
6. **Q9 関連**: `package.json` に `eslint + @typescript-eslint + eslint-plugin-promise` を追加し `lint` を `tsc --noEmit && eslint .` に。
7. **M1 関連**: 別 repo (LUDIARS/LUDIARS) に「AIFormat §5 に Quaestor 例外を追記」 issue を起票 (これは Quaestor リポ修正ではない)。
8. **I1 関連**: `src/shared/types.ts` の `Importer.parse` 返り値を `ImporterResult | Promise<ImporterResult>` に拡張、 `api/imports.ts:65` で `await Promise.resolve(picked.importer.parse(...))` に統一。
9. **I4 関連**: `src/importers/ufj-csv.ts:58-60` の `row[10]/row[11]` を header sniff (`findIdx("currency", "通貨")`) ベースに切り替え。

これらは別セッションで個別 PR にする想定。 適用前にユーザ承認必須。

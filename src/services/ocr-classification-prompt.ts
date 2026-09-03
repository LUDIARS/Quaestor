/**
 * 書類種別 (kind) とサンプルラベル (sample) を LLM に判定させる prompt 断片。
 *
 * レシート OCR (claude-code-ocr.ts、 fields と同時に 1 回で返させる) と、 既存レシートの
 * 後付けラベル CLI (sample-labeler.ts、 kind と sample だけ返させる) が同じ判定基準を使う。
 * 基準文は shared/document-kinds.ts の語彙から組み立て、 prompt と schema CHECK がずれないようにする。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-004 (spec/feature/scan-document-kinds.md)
 */

import {
  CONTENT_TAGS,
  DOC_KINDS,
  DOC_KIND_INFO,
  SAMPLE_ROLES,
  SAMPLE_ROLE_INFO,
  SAMPLE_TAGS,
} from "../shared/document-kinds.js";

/** 種別の判定基準 (設計書 §2.2 表)。 */
export function docKindCriteria(): string {
  const lines = DOC_KINDS.map((k) => `   - \`${k}\` (${DOC_KIND_INFO[k].label}): ${DOC_KIND_INFO[k].description}`);
  return [
    ...lines,
    "   - 検針票と請求書の境界: 供給者 + 使用期間 + 使用量 が揃えば `utility`、 揃わなければ `invoice`",
    "   - 印字でなく手書きが主体なら、 内容がレシート風でも `handwritten`",
    "   - 確信度が低い (判別に迷う / 書類でない) ときは `other` にする (無理に当てはめない)",
  ].join("\n");
}

/** 種別固有フィールドの形。 */
export function kindFieldsShape(): string {
  return [
    "   - `invoice`   : {\"issuer\": 発行者, \"due_date\": \"yyyy-mm-dd\"|null, \"invoice_no\": 請求番号|null}",
    "   - `utility`   : {\"supplier\": 供給者, \"period_from\": \"yyyy-mm-dd\"|null, \"period_to\": \"yyyy-mm-dd\"|null, \"usage\": \"123 kWh\" のような単位付き文字列|null}",
    "   - `statement` : {\"rows\": [{\"date\": \"yyyy-mm-dd\"|null, \"description\": 摘要, \"amount\": 円整数|null}, ...]}",
    "   - `receipt` / `handwritten` / `other` : null",
  ].join("\n");
}

/** サンプルラベルの判定基準 (設計書 §3.1-1)。 */
export function sampleLabelCriteria(): string {
  const roles = SAMPLE_ROLES.map((r) => `   - \`${r}\` (${SAMPLE_ROLE_INFO[r].label}): ${SAMPLE_ROLE_INFO[r].description}`);
  return [
    ...roles,
    `   - \`tags\`: 形状タグの配列。 候補: ${SAMPLE_TAGS.join(" / ")} (候補外でも英小文字 snake_case なら可)。 \`special_shape\` のときは 1 つ以上`,
    "   - `reason`: 人が一覧で見るための一言 (日本語、 40 文字以内)",
  ].join("\n");
}

/** 内容タグ。 */
export function contentTagCriteria(): string {
  return `   候補: ${CONTENT_TAGS.join(" / ")} (複数可、 該当なしは [])。 種別とは独立に「何の支出か」を表す`;
}

/**
 * OCR prompt に挿す分類セクション。 fields (date/payee/total/items) の抽出手順の直後に置く。
 */
export function classificationPromptSection(): string {
  return `## 書類種別とサンプルラベル (fields と同じ 1 回の応答で返す。 別途問い直さない)

- \`kind\`: 次の 6 種のどれか 1 つ
${docKindCriteria()}

- \`kind_fields\`: 種別固有フィールド (読めない項目は null)
${kindFieldsShape()}

- \`sample\`: この画像を OCR 学習のサンプルとしてどう扱うか {role, tags, reason}
${sampleLabelCriteria()}

- \`content_tags\`: 内容タグの配列
${contentTagCriteria()}

種別が \`receipt\` 以外でも、 読める範囲で date / payee (発行者・供給者) / total (請求額) は埋める。`;
}

/**
 * 後付けラベル CLI 用の prompt。 画像は claude がローカルファイルを Read で視認する。
 * fields は再抽出させず、 kind と sample (と content_tags) だけを JSON 1 個で返させる。
 */
export function buildLabelOnlyPrompt(absoluteImagePath: string): string {
  return `# Quaestor レシート画像の分類タスク (ラベルのみ)

あなたは Quaestor (個人会計サービス) の書類分類ヘルパーとして起動された。
画像 1 枚を見て、 書類種別と OCR 学習サンプルとしてのラベルだけを返す。 金額・日付・品目の抽出はしない。

## 手順

1. Read tool で次の画像ファイルを読む (multimodal で視認できる):
   ${absoluteImagePath}

2. 次の基準で判定する。

- \`kind\`: 次の 6 種のどれか 1 つ
${docKindCriteria()}

- \`sample\`: {role, tags, reason}
${sampleLabelCriteria()}

- \`content_tags\`: 内容タグの配列
${contentTagCriteria()}

3. 応答は次の JSON オブジェクト **1 個だけ** を出力する (前後に説明文やコードフェンスを付けない):

{"kind": "receipt", "sample": {"role": "good_sample", "tags": [], "reason": "全体が写り判読できる"}, "content_tags": ["food"]}

## 注意

- 画像ファイルを編集したり、 他のファイルを触ったり、 別タスクに脱線しない
- 判別に迷う場合は kind="other"、 sample.role="none" にする (推測で当てはめない)
`;
}

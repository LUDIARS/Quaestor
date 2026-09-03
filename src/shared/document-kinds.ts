/**
 * 書類種別 (doc_kind) と LLM サンプルラベルの語彙。
 *
 * backend (schema CHECK / OCR prompt / 投入ゲート / API 検証) と web (バッジ / 上書き UI /
 * 撮影対象パネル) が同じ 6 種・同じ表示名を使うための単一の正本。 Node 依存を持たない純粋な定数と
 * 判定関数だけを置く (web からも `../../../src/shared/document-kinds.js` で読む)。
 *
 * 設計書: spec/plan (Castra) 2026-09-03-quaestor-scan-diversification-ga-evaluation.md §2.2 / §3.1
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
 */

export const DOC_KINDS = ["receipt", "invoice", "utility", "statement", "handwritten", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const SAMPLE_ROLES = ["good_sample", "special_shape", "none"] as const;
export type SampleRole = (typeof SAMPLE_ROLES)[number];

export const SAMPLE_SOURCES = ["llm", "manual"] as const;
export type SampleSource = (typeof SAMPLE_SOURCES)[number];

/** 形状タグ (special_shape のとき 1 つ以上)。 未知のタグも slug なら受け入れる。 */
export const SAMPLE_TAGS = [
  "long", "folded", "faded", "rotated", "handwritten", "multi_column",
  "glare", "cropped", "low_light", "wide_paper",
] as const;

/** 内容タグ。 種別に昇格するまでの受け皿 (medical / transport など)。 */
export const CONTENT_TAGS = [
  "medical", "transport", "food", "daily", "clothing", "entertainment",
  "education", "business", "tax_public", "communication",
] as const;

/**
 * 投入ゲートでの扱い。
 *  - receipt_rules: 現行どおり (日付-場所-金額 完備 + 重複無し) で自動投入
 *  - manual_only:   自動投入せず要確認に残す。 手動投入は receipt_rules で通す
 *  - not_wired:     投入先が未配線。 自動・手動とも投入しない (種別を直してから投入)
 */
export type CommitPolicy = "receipt_rules" | "manual_only" | "not_wired";

export interface DocKindInfo {
  kind: DocKind;
  /** UI バッジ表示名 (日本語) */
  label: string;
  /** 何を指す種別か (prompt の判定基準にも使う) */
  description: string;
  /** 撮ったあと何処へ流れるか (撮影対象パネル / 投入不可メッセージ) */
  destination: string;
  commitPolicy: CommitPolicy;
}

export const DOC_KIND_INFO: Record<DocKind, DocKindInfo> = {
  receipt: {
    kind: "receipt",
    label: "レシート",
    description: "店頭で受け取るレシート・領収書 (印字。 店名・日付・合計・品目)",
    destination: "レシートとして投入 → クレカ明細と突合 → 家計分析",
    commitPolicy: "receipt_rules",
  },
  invoice: {
    kind: "invoice",
    label: "請求書",
    description: "請求書 (発行者・請求番号・支払期限・請求額。「請求書」「御請求」「振込先」など)",
    destination: "請求書として保留 (仕訳への配線は次版)",
    commitPolicy: "not_wired",
  },
  utility: {
    kind: "utility",
    label: "検針票",
    description: "検針票・公共料金 (電気 / ガス / 水道 / 通信の供給者 + 使用期間 + 使用量 + 金額)",
    destination: "水道光熱費として保留 (固定費・変動費への反映は次版)",
    commitPolicy: "not_wired",
  },
  statement: {
    kind: "statement",
    label: "明細",
    description: "クレカ / 銀行の明細 (日付・摘要・金額の行が複数並ぶ表。 画面キャプチャを含む)",
    destination: "取引明細として保留 (明細取込への合流は次版)",
    commitPolicy: "not_wired",
  },
  handwritten: {
    kind: "handwritten",
    label: "手書き",
    description: "手書きの領収書・メモ (印字でなく手書きが主体)",
    destination: "要確認に残す (内容を確かめて手で投入)",
    commitPolicy: "manual_only",
  },
  other: {
    kind: "other",
    label: "その他",
    description: "上記に当てはまらない、 または確信が持てないもの (背景・名刺・広告など)",
    destination: "投入せず要確認に残す",
    commitPolicy: "not_wired",
  },
};

export interface SampleRoleInfo {
  role: SampleRole;
  label: string;
  description: string;
}

export const SAMPLE_ROLE_INFO: Record<SampleRole, SampleRoleInfo> = {
  good_sample: {
    role: "good_sample",
    label: "適切",
    description: "全体が写り、 日付・店名・金額が判読でき、 標準的なレイアウト (学習の基準サンプル)",
  },
  special_shape: {
    role: "special_shape",
    label: "特殊形状",
    description: "長尺・折れ・感熱の退色・回転 / 斜め・手書き・多段組・光沢 / 反射・切れ など (形状タグを 1 つ以上付ける)",
  },
  none: {
    role: "none",
    label: "—",
    description: "どちらでもない (学習に使わない)",
  },
};

export function isDocKind(v: unknown): v is DocKind {
  return typeof v === "string" && (DOC_KINDS as readonly string[]).includes(v);
}

export function isSampleRole(v: unknown): v is SampleRole {
  return typeof v === "string" && (SAMPLE_ROLES as readonly string[]).includes(v);
}

/** タグは slug (英小文字・数字・_) 32 文字まで。 LLM の表記ゆれ (大文字 / ハイフン / 空白) は寄せる。 */
const TAG_PATTERN = /^[a-z0-9_]{1,32}$/;
export const MAX_TAGS = 16;

export function normalizeTag(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const slug = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TAG_PATTERN.test(slug) ? slug : null;
}

/** 配列でない / 空なら []。 不正要素は捨て、 重複を除いて MAX_TAGS 件まで。 */
export function normalizeTagList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const tag = normalizeTag(item);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** JSON 文字列 (DB 列) → タグ配列。 壊れていれば []。 */
export function parseTagList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    return normalizeTagList(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * 書類種別とサンプルラベルの適用ルール。
 *
 *  - LLM (OCR / 後付け CLI) が付けるラベルは source='llm'。
 *  - 人が上書きしたラベルは source='manual' として残り、 以後の LLM 再解析では上書きされない
 *    (再撮影・再 OCR で人の判断が消えないようにする)。
 *
 * 書き込みは ReceiptsRepo.setLabels、 語彙は shared/document-kinds.ts。 ここは判断だけ持つ。
 *
 * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-003 (spec/feature/scan-document-kinds.md)
 */

import type { ReceiptsRepo, UpdateLabelsInput } from "../db/receipts-repo.js";
import {
  isDocKind,
  isSampleRole,
  normalizeTagList,
  parseTagList,
  type DocKind,
  type SampleRole,
} from "../shared/document-kinds.js";
import { normalizeKindFields, type KindFields } from "../shared/receipt-kind-fields.js";

export const MAX_SAMPLE_REASON = 200;

/** LLM が返す分類 (OCR の JSON と後付け CLI の JSON で共通)。 */
export interface LlmLabels {
  kind: DocKind;
  kind_fields: KindFields | null;
  sample: { role: SampleRole; tags: string[]; reason: string | null } | null;
  content_tags: string[];
}

/** 人手上書き (PATCH /v1/receipts/:id/labels)。 undefined の項目は触らない。 */
export interface ManualLabelPatch {
  doc_kind?: DocKind;
  sample_role?: SampleRole | null;
  sample_tags?: string[] | null;
  sample_reason?: string | null;
  content_tags?: string[] | null;
}

export type ApplyLabelsOutcome =
  | { applied: true; source: "llm" | "manual" }
  | { applied: false; reason: "not_found" | "manual_override" | "empty" | "special_shape_requires_tag" | "committed_kind_immutable" };

/**
 * LLM 出力 (unknown JSON) を LlmLabels に正規化する。 kind が語彙外なら null (= 保存しない)。
 * sample.role が語彙外なら sample は null のまま (kind だけ採る)。
 */
export function normalizeLlmLabels(value: unknown): LlmLabels | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!isDocKind(obj.kind)) return null;
  const kind = obj.kind;

  let sample: LlmLabels["sample"] = null;
  const s = obj.sample;
  if (s && typeof s === "object" && !Array.isArray(s)) {
    const so = s as Record<string, unknown>;
    if (isSampleRole(so.role)) {
      const tags = normalizeTagList(so.tags);
      if (so.role !== "special_shape" || tags.length > 0) {
        sample = { role: so.role, tags, reason: reasonText(so.reason) };
      }
    }
  }

  return {
    kind,
    kind_fields: normalizeKindFields(kind, obj.kind_fields),
    sample,
    content_tags: normalizeTagList(obj.content_tags),
  };
}

/**
 * LLM のラベルを書く。 人手上書き済 (sample_source='manual') なら書かない。
 * sample が無い (kind だけ) 場合も種別と内容タグは更新する。
 */
export function applyLlmLabels(repo: ReceiptsRepo, id: string, labels: LlmLabels): ApplyLabelsOutcome {
  const row = repo.find(id);
  if (!row) return { applied: false, reason: "not_found" };
  if (row.sample_source === "manual") return { applied: false, reason: "manual_override" };
  if (row.committed_at != null && labels.kind !== row.doc_kind) {
    return { applied: false, reason: "committed_kind_immutable" };
  }

  const input: UpdateLabelsInput = {
    doc_kind: labels.kind,
    kind_fields: labels.kind_fields,
    content_tags: labels.content_tags,
    sample_source: "llm",
  };
  if (labels.sample) {
    input.sample_role = labels.sample.role;
    input.sample_tags = labels.sample.tags;
    input.sample_reason = labels.sample.reason;
  }
  repo.setLabels(id, input);
  return { applied: true, source: "llm" };
}

/** 人手上書き。 以後 LLM は触らない。 */
export function applyManualLabels(repo: ReceiptsRepo, id: string, patch: ManualLabelPatch): ApplyLabelsOutcome {
  const row = repo.find(id);
  if (!row) return { applied: false, reason: "not_found" };
  if (row.committed_at != null && patch.doc_kind !== undefined && patch.doc_kind !== row.doc_kind) {
    return { applied: false, reason: "committed_kind_immutable" };
  }

  if (patch.sample_role !== undefined || patch.sample_tags !== undefined) {
    const effectiveRole = patch.sample_role !== undefined ? patch.sample_role : row.sample_role;
    const effectiveTags = patch.sample_tags !== undefined
      ? normalizeTagList(patch.sample_tags ?? [])
      : parseTagList(row.sample_tags);
    if (effectiveRole === "special_shape" && effectiveTags.length === 0) {
      return { applied: false, reason: "special_shape_requires_tag" };
    }
  }

  const input: UpdateLabelsInput = { sample_source: "manual" };
  let touched = false;
  if (patch.doc_kind !== undefined) {
    input.doc_kind = patch.doc_kind;
    // 種別が変わったら旧種別の固有フィールドは意味を失う
    if (patch.doc_kind !== row.doc_kind) input.kind_fields = null;
    touched = true;
  }
  if (patch.sample_role !== undefined) { input.sample_role = patch.sample_role; touched = true; }
  if (patch.sample_tags !== undefined) {
    input.sample_tags = patch.sample_tags ? normalizeTagList(patch.sample_tags) : null;
    touched = true;
  }
  if (patch.sample_reason !== undefined) { input.sample_reason = reasonText(patch.sample_reason); touched = true; }
  if (patch.content_tags !== undefined) {
    input.content_tags = patch.content_tags ? normalizeTagList(patch.content_tags) : null;
    touched = true;
  }
  if (!touched) return { applied: false, reason: "empty" };

  repo.setLabels(id, input);
  return { applied: true, source: "manual" };
}

function reasonText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_SAMPLE_REASON) : null;
}

/**
 * 書類種別 / サンプルラベルの HTTP クライアント (PATCH /v1/receipts/:id/labels)。
 *
 * 撮影一覧 (ShotCard) とレシート一覧 (Receipts) の DocKindLabels が共有する。
 * 語彙は backend と同じ shared/document-kinds を読む。
 *
 * @implements SPEC-SCAN-KIND-003 (spec/feature/scan-document-kinds.md)
 */

import type { DocKind, SampleRole, SampleSource } from "../../../src/shared/document-kinds.js";

/** API が返す receipt のうち、 ラベル UI が扱う列。 */
export interface LabeledReceipt {
  id: string;
  doc_kind: DocKind;
  sample_role: SampleRole | null;
  /** JSON 配列 (文字列のまま持つ。 表示時に parseTagList) */
  sample_tags: string | null;
  sample_reason: string | null;
  sample_source: SampleSource | null;
  content_tags: string | null;
}

export interface LabelsPatch {
  doc_kind?: DocKind;
  sample_role?: SampleRole | null;
  sample_tags?: string[] | null;
  sample_reason?: string | null;
  content_tags?: string[] | null;
}

export async function patchReceiptLabels(id: string, patch: LabelsPatch): Promise<LabeledReceipt> {
  const res = await fetch(`/v1/receipts/${id}/labels`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const j = await res.json().catch(() => ({})) as { receipt?: LabeledReceipt; error?: string };
  if (!res.ok || !j.receipt) throw new Error(j.error ?? `PATCH /v1/receipts/${id}/labels ${res.status}`);
  return j.receipt;
}

/** ラベル列を持たない古い応答 (POST /v1/receipts 直後など) を既定値で埋める。 */
export function withDefaultLabels<T extends { id: string }>(r: T & Partial<LabeledReceipt>): T & LabeledReceipt {
  return {
    ...r,
    doc_kind: r.doc_kind ?? "receipt",
    sample_role: r.sample_role ?? null,
    sample_tags: r.sample_tags ?? null,
    sample_reason: r.sample_reason ?? null,
    sample_source: r.sample_source ?? null,
    content_tags: r.content_tags ?? null,
  };
}

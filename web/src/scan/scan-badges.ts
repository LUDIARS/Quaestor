/**
 * 書類種別 / サンプル区分 → スキャン演出のバッジ (ScanBadge) と UI 色。
 *
 * 語彙 (種別・表示名) は shared/document-kinds、 ここは色と並びだけ持つ。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
 */

import {
  DOC_KIND_INFO,
  SAMPLE_ROLE_INFO,
  type DocKind,
  type SampleRole,
} from "../../../src/shared/document-kinds.js";
import type { ScanBadge } from "../scanner/types.js";

export const DOC_KIND_COLORS: Record<DocKind, string> = {
  receipt: "#00ffc8",
  invoice: "#fbbf24",
  utility: "#60a5fa",
  statement: "#a78bfa",
  handwritten: "#fb923c",
  other: "#9ca3af",
};

export const SAMPLE_ROLE_COLORS: Record<SampleRole, string> = {
  good_sample: "#34d399",
  special_shape: "#f472b6",
  none: "#9ca3af",
};

export function docKindBadge(kind: DocKind): ScanBadge {
  return { id: "kind", text: DOC_KIND_INFO[kind].label, color: DOC_KIND_COLORS[kind] };
}

export function sampleRoleBadge(role: SampleRole): ScanBadge {
  return { id: "sample", text: SAMPLE_ROLE_INFO[role].label, color: SAMPLE_ROLE_COLORS[role] };
}

/** 種別は常に、 サンプル区分はラベル済みのときだけ。 */
export function scanBadgesFor(r: { doc_kind: DocKind; sample_role: SampleRole | null }): ScanBadge[] {
  const out = [docKindBadge(r.doc_kind)];
  if (r.sample_role) out.push(sampleRoleBadge(r.sample_role));
  return out;
}

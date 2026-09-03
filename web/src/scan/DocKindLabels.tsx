import { useState } from "react";
import "./DocKindLabels.css";
import {
  CONTENT_TAGS,
  DOC_KINDS,
  DOC_KIND_INFO,
  SAMPLE_ROLES,
  SAMPLE_ROLE_INFO,
  SAMPLE_TAGS,
  parseTagList,
  type DocKind,
  type SampleRole,
} from "../../../src/shared/document-kinds.js";
import { DOC_KIND_COLORS, SAMPLE_ROLE_COLORS } from "./scan-badges.js";
import { patchReceiptLabels, type LabeledReceipt, type LabelsPatch } from "./receiptLabelsApi.js";

const UNLABELED_COLOR = "#6b7280";

interface Props {
  receipt: LabeledReceipt;
  /** PATCH 成功後、 更新済み receipt を親の state に反映する */
  onChanged?: (receipt: LabeledReceipt) => void;
}

/**
 * 書類種別・サンプルラベル・タグの表示と 1 タップ上書き。
 *
 * 畳んだ状態は バッジ (種別 / サンプル区分) + タグ の 1 行。 バッジをタップすると
 * チップ列 (種別 6 / サンプル 3 / 形状タグ / 内容タグ) が開き、 チップ 1 タップで PATCH する。
 * 人手で直した値は sample_source='manual' になり、 以後の再 OCR で上書きされない (✍ で示す)。
 *
 * 撮影一覧 (ShotCard) とレシート一覧 (Receipts) で共有する。
 *
 * @implements SPEC-SCAN-KIND-003 (spec/feature/scan-document-kinds.md)
 */
export function DocKindLabels({ receipt, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sampleTags = parseTagList(receipt.sample_tags);
  const contentTags = parseTagList(receipt.content_tags);
  const kindInfo = DOC_KIND_INFO[receipt.doc_kind];
  const roleInfo = receipt.sample_role ? SAMPLE_ROLE_INFO[receipt.sample_role] : null;

  async function apply(patch: LabelsPatch) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await patchReceiptLabels(receipt.id, patch);
      onChanged?.(updated);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(list: string[], tag: string): string[] {
    return list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
  }

  return (
    <div className="dkl">
      <div className="dkl-row">
        <button
          type="button"
          className="dkl-badge"
          style={{ "--dkl-clr": DOC_KIND_COLORS[receipt.doc_kind] } as React.CSSProperties}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={`${kindInfo.description} → ${kindInfo.destination} (タップで直す)`}
        >
          {kindInfo.label}
        </button>
        <button
          type="button"
          className="dkl-badge"
          style={{ "--dkl-clr": receipt.sample_role ? SAMPLE_ROLE_COLORS[receipt.sample_role] : UNLABELED_COLOR } as React.CSSProperties}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={roleInfo ? `${roleInfo.description} (タップで直す)` : "サンプルラベル未付与 (タップで付ける)"}
        >
          {roleInfo ? roleInfo.label : "未ラベル"}
        </button>
        {sampleTags.map((t) => <span key={`s-${t}`} className="dkl-tag">#{t}</span>)}
        {contentTags.map((t) => <span key={`c-${t}`} className="dkl-tag dkl-tag--content">{t}</span>)}
        {receipt.sample_source === "manual" && (
          <span className="dkl-src" title="人手で上書き済 (再 OCR で変わらない)">✍</span>
        )}
        {receipt.sample_reason && <span className="dkl-reason">{receipt.sample_reason}</span>}
      </div>

      {open && (
        <div className="dkl-editor" aria-busy={busy}>
          <ChipRow
            label="種別"
            items={DOC_KINDS.map((k: DocKind) => ({
              value: k, text: DOC_KIND_INFO[k].label, color: DOC_KIND_COLORS[k],
              active: receipt.doc_kind === k, title: DOC_KIND_INFO[k].destination,
            }))}
            disabled={busy}
            onPick={(k) => { if (k !== receipt.doc_kind) void apply({ doc_kind: k as DocKind }); }}
          />
          <ChipRow
            label="サンプル"
            items={SAMPLE_ROLES.map((r: SampleRole) => ({
              value: r, text: SAMPLE_ROLE_INFO[r].label, color: SAMPLE_ROLE_COLORS[r],
              active: receipt.sample_role === r, title: SAMPLE_ROLE_INFO[r].description,
            }))}
            disabled={busy}
            onPick={(r) => { if (r !== receipt.sample_role) void apply({ sample_role: r as SampleRole }); }}
          />
          <ChipRow
            label="形状"
            items={[...new Set([...SAMPLE_TAGS, ...sampleTags])].map((t) => ({
              value: t, text: `#${t}`, active: sampleTags.includes(t),
            }))}
            disabled={busy}
            onPick={(t) => void apply({ sample_tags: toggle(sampleTags, t) })}
          />
          <ChipRow
            label="内容"
            items={[...new Set([...CONTENT_TAGS, ...contentTags])].map((t) => ({
              value: t, text: t, active: contentTags.includes(t),
            }))}
            disabled={busy}
            onPick={(t) => void apply({ content_tags: toggle(contentTags, t) })}
          />
          {err && <div className="error dkl-err">{err}</div>}
        </div>
      )}
    </div>
  );
}

interface ChipItem {
  value: string;
  text: string;
  active: boolean;
  color?: string;
  title?: string;
}

function ChipRow({
  label,
  items,
  disabled,
  onPick,
}: {
  label: string;
  items: ChipItem[];
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div className="dkl-chips" role="group" aria-label={label}>
      <span className="dkl-chips-label">{label}</span>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          className={`dkl-chip${it.active ? " is-active" : ""}`}
          style={it.color ? ({ "--dkl-clr": it.color } as React.CSSProperties) : undefined}
          aria-pressed={it.active}
          disabled={disabled}
          title={it.title}
          onClick={() => onPick(it.value)}
        >
          {it.text}
        </button>
      ))}
    </div>
  );
}

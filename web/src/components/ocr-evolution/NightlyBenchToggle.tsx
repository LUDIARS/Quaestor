/**
 * 夜間評価バッチ (`training.gaBench.enabled`) の on/off。
 *
 * `PUT /v1/config/ga-bench` で quaestor.config.json に書き戻す (作法は `/v1/config/web` と同じ)。
 * 夜間ジョブは backend が起動時に組み立てるので、**反映は再起動後**である旨を必ず出す。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import { useState } from "react";

export function NightlyBenchToggle({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: boolean) {
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await fetch("/v1/config/ga-bench", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await res.json() as { enabled?: boolean; note?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setNote(body.note ?? null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className={enabled ? "text-xs text-green-700" : "text-xs text-gray-500"}>
          夜間バッチ: {enabled ? "有効" : "無効"}
        </span>
        <button
          disabled={busy}
          onClick={() => void apply(!enabled)}
          className="px-2 py-0.5 bg-blue-50 border border-blue-400 text-blue-700 rounded text-xs disabled:opacity-40"
        >
          {enabled ? "無効にする" : "有効にする"}
        </button>
      </div>
      <div className="text-xs text-amber-600">変更は Quaestor backend の再起動後に反映されます。</div>
      {note && <div className="text-xs text-gray-500">{note}</div>}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

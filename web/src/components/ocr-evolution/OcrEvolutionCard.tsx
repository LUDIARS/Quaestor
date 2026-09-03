/**
 * 設定ページの「OCR 進化」カード。
 *
 * OCR-GA は稼働開始 (2026-06-11) から一度も世代を進めていなかったのに誰も気付かなかった。
 * 進化の状態と sidecar の生死がどこにも出ていなかったのが理由なので、このカードの主目的は
 * **「測定系が死んでいる」ことが画面で分かる**こと (設計書 §0-2(c))。
 *
 * 数値は出すが、効いている / いないの判定はしない — 閾値は仮置きで自動化しない (§3.2)。
 * 撮影演出はこのカードにも sidecar にも依存しない (従来どおりエンジン非依存)。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import { useCallback, useEffect, useState } from "react";
import { LabelRow } from "./LabelRow";
import { NightlyBenchToggle } from "./NightlyBenchToggle";
import type { GaStatusProduction, GaStatusWarning, OcrGaStatus } from "./types";

export function OcrEvolutionCard() {
  const [status, setStatus] = useState<OcrGaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/v1/ocr-ga/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json() as OcrGaStatus);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">OCR 進化 (OCR-GA)</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          ラベル別の夜間評価バッチの状態。世代が進んでいるか、sidecar が生きているかを見るための表示で、
          「効いている / いない」の判定はしません (閾値は仮置き)。撮影の演出はこの状態に依存しません。
        </p>
      </div>

      {error && <div className="text-xs text-red-600">status の取得に失敗しました: {error}</div>}
      {!status && loading && <div className="text-sm text-gray-400">...</div>}

      {status && (
        <div className="border rounded p-3 space-y-3">
          <WarningList warnings={status.warnings} />

          <div className="space-y-1">
            <NightlyBenchToggle enabled={status.config.enabled} onChanged={() => void refresh()} />
            <div className="text-xs text-gray-500">
              実行時刻 {status.config.hour}:00 / 1 晩 {status.config.generationsPerNight} 世代 /
              {" "}device {status.config.device} / コスト係数 {status.config.costPerSecond}
            </div>
          </div>

          <SidecarLine status={status} />

          <div className="space-y-2">
            <div className="text-xs text-gray-400">
              ラベル別 (最終評価 {status.bench ? new Date(status.bench.ts).toLocaleString() : "未実施"})
            </div>
            {status.labels.length === 0
              ? <div className="text-sm text-gray-400">評価されたラベルがありません。</div>
              : status.labels.map((label) => <LabelRow key={label.label} label={label} />)}
          </div>

          {status.production && <ProductionLine production={status.production} />}

          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="px-3 py-1 bg-gray-50 border border-gray-300 text-gray-700 rounded text-sm disabled:opacity-40"
          >
            再読込
          </button>
        </div>
      )}
    </div>
  );
}

function WarningList({ warnings }: { warnings: GaStatusWarning[] }) {
  if (warnings.length === 0) {
    return <div className="text-xs text-green-700">警告なし (バッチも sidecar も応答しています)。</div>;
  }
  return (
    <ul className="space-y-1">
      {warnings.map((w) => (
        <li key={w.code} className="text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded px-2 py-1">
          {w.message}
        </li>
      ))}
    </ul>
  );
}

function SidecarLine({ status }: { status: OcrGaStatus }) {
  const { sidecar } = status;
  return (
    <div className="text-xs space-y-0.5">
      <div>
        <span className="text-gray-400">sidecar</span>{" "}
        <code>{sidecar.url}</code>{" "}
        {sidecar.reachable && sidecar.ok
          ? <span className="text-green-700">到達 ({sidecar.device ?? "device 不明"})</span>
          : <span className="text-red-600">不達</span>}
      </div>
      {sidecar.error && <div className="text-red-600 break-all">{sidecar.error}</div>}
      {sidecar.deviceError && <div className="text-amber-600 break-all">device: {sidecar.deviceError}</div>}
    </div>
  );
}

/** B-1 の運用評価レコード (production-eval.jsonl)。レコードが無ければ status に来ないので描かない */
function ProductionLine({ production }: { production: GaStatusProduction }) {
  return (
    <div className="text-xs text-gray-600 space-y-0.5 border-t pt-2">
      <div className="text-gray-400">実運用 (撮影時検出、直近 {production.window} 件)</div>
      <div>
        {production.count} 件 / fitness 平均 {production.meanFitness.toFixed(3)}
        {production.meanBaselineFitness != null
          ? <> / baseline 平均 {production.meanBaselineFitness.toFixed(3)} (差 {signed(production.baselineDelta)}, {production.baselineSamples} 件)</>
          : <> / baseline 未取得</>}
      </div>
      <div>
        field hit: date {pct(production.meanFieldHits.date)} / payee {pct(production.meanFieldHits.payee)}
        {" / "}total {pct(production.meanFieldHits.total)}
      </div>
      <div className="text-gray-400">最新 {new Date(production.latestTs).toLocaleString()}</div>
    </div>
  );
}

function signed(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
